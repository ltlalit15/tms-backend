const Trip = require('../models/Trip');
const Ledger = require('../models/Ledger');
const Dispute = require('../models/Dispute');
const { createAuditLog } = require('../middleware/auditLog');

// Helper function to transform trip for frontend
const transformTrip = (trip) => {
  if (!trip) return null;
  const tripObj = trip.toObject ? trip.toObject() : trip;
  
  // Transform attachments.uploadedBy from object to string
  const transformedAttachments = tripObj.attachments?.map(att => ({
    ...att,
    uploadedBy: att.uploadedBy?.name || att.uploadedBy || 'Unknown',
  })) || tripObj.attachments;
  
  // Transform onTripPayments.addedBy from object to string (if exists)
  const transformedPayments = tripObj.onTripPayments?.map(payment => ({
    ...payment,
    addedBy: payment.addedBy?.name || payment.addedBy || payment.addedByRole || 'Unknown',
  })) || tripObj.onTripPayments;
  
  return {
    ...tripObj,
    id: tripObj._id,
    agentId: tripObj.agent?._id || tripObj.agentId?._id || tripObj.agentId,
    agent: tripObj.agent?.name || tripObj.agentId?.name || tripObj.agent,
    attachments: transformedAttachments,
    onTripPayments: transformedPayments,
  };
};

// @desc    Get all trips
// @route   GET /api/trips
// @access  Public
const getTrips = async (req, res) => {
  try {
    const { agentId, branch, status, lrNumber, page = 1, limit = 50 } = req.query;
    let query = {};

    // No role-based filtering - all trips visible to all
    // Additional filters
    if (agentId) {
      query.agent = agentId;
    }
    if (branch) {
      query.branch = branch;
    }
    if (status) {
      query.status = status;
    }
    if (lrNumber) {
      query.$or = [
        { lrNumber: { $regex: lrNumber, $options: 'i' } },
        { tripId: { $regex: lrNumber, $options: 'i' } },
      ];
    }

    const trips = await Trip.find(query)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Trip.countDocuments(query);

    // Transform trips to match frontend expectations
    const transformedTrips = trips.map(trip => ({
      ...trip.toObject(),
      id: trip._id,
      agentId: trip.agent?._id || trip.agentId?._id || trip.agentId,
      agent: trip.agent?.name || trip.agentId?.name || trip.agent,
      // Ensure agent object is available for frontend
      agentDetails: trip.agent || trip.agentId,
    }));

    // Return array format for frontend compatibility
    res.json(transformedTrips);
  } catch (error) {
    console.error('Get trips error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get single trip
// @route   GET /api/trips/:id
// @access  Public
const getTrip = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .populate('onTripPayments.addedBy', 'name role _id')
      .populate('attachments.uploadedBy', 'name role _id');

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // No access check - public access
    // Transform to match frontend expectations
    const transformedTrip = {
      ...trip.toObject(),
      id: trip._id,
      agentId: trip.agent?._id || trip.agentId?._id || trip.agentId,
      agent: trip.agent?.name || trip.agentId?.name || trip.agent,
    };

    res.json(transformedTrip);
  } catch (error) {
    console.error('Get trip error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Create trip
// @route   POST /api/trips
// @access  Public
const createTrip = async (req, res) => {
  try {
    const {
      lrNumber,
      tripId,
      date,
      truckNumber,
      companyName,
      routeFrom,
      routeTo,
      tonnage,
      lrSheet,
      isBulk,
      freightAmount,
      advancePaid,
      agentId, // Frontend se agentId aayega
      branchId, // Frontend se branchId aayega (optional)
    } = req.body;

    if (!agentId) {
      return res.status(400).json({ message: 'agentId is required' });
    }

    // Get agent to get branch if branchId not provided
    const User = require('../models/User');
    const agent = await User.findById(agentId);
    if (!agent) {
      return res.status(404).json({ message: 'Agent not found' });
    }

    // Calculate balance
    const freight = isBulk ? 0 : (parseFloat(freightAmount) || 0);
    const advance = isBulk ? 0 : (parseFloat(advancePaid) || 0);
    const balance = freight - advance;

    const trip = await Trip.create({
      lrNumber,
      tripId: tripId || lrNumber,
      date,
      truckNumber,
      companyName,
      routeFrom,
      routeTo,
      route: `${routeFrom} - ${routeTo}`,
      tonnage: parseFloat(tonnage) || 0,
      lrSheet: lrSheet || 'Not Received',
      isBulk: isBulk || false,
      type: isBulk ? 'Bulk' : 'Normal',
      freight,
      freightAmount: freight,
      advance,
      advancePaid: advance,
      balance,
      balanceAmount: balance,
      status: 'Active',
      agent: agentId,
      agentId: agentId,
      branch: branchId || agent.branch || null,
    });

    // Create ledger entry - Only debit the advance amount paid by agent, NOT the freight
    // Freight is informational, not a wallet transaction
    if (!isBulk && advance > 0) {
      await Ledger.create({
        tripId: trip._id,
        lrNumber: trip.lrNumber,
        date: trip.date,
        description: `Trip created - ${routeFrom} to ${routeTo} (Advance paid: Rs ${advance})`,
        type: 'Trip Created',
        amount: advance, // Only debit the advance amount, not freight
        advance: advance,
        balance: balance,
        agent: agentId,
        agentId: agentId,
        bank: 'HDFC Bank',
        direction: 'Debit',
      });
    }

    // Populate trip with error handling
    let populatedTrip;
    try {
      populatedTrip = await Trip.findById(trip._id)
        .populate('agent', 'name email phone branch _id')
        .populate('agentId', 'name email phone branch _id');
    } catch (populateError) {
      console.error('Populate error (non-critical):', populateError);
      // If populate fails, use trip without populate
      populatedTrip = trip;
    }

    // Transform trip with error handling
    let transformedTrip;
    try {
      transformedTrip = transformTrip(populatedTrip);
    } catch (transformError) {
      console.error('Transform error (non-critical):', transformError);
      // If transform fails, send basic trip data
      transformedTrip = {
        ...(populatedTrip.toObject ? populatedTrip.toObject() : populatedTrip),
        id: trip._id,
        agentId: agentId,
        agent: agent?.name || 'Unknown',
      };
    }

    // Create audit log (don't fail if this fails)
    try {
      await createAuditLog(
        agentId,
        agent?.role || 'Agent',
        'Create Trip',
        'Trip',
        trip._id,
        {
          lrNumber: trip.lrNumber,
          route: trip.route,
          freight: trip.freight,
          advance: trip.advance,
          status: trip.status,
        },
        req.ip
      );
    } catch (auditError) {
      console.error('Audit log error (non-critical):', auditError);
      // Continue even if audit log fails
    }

    res.status(201).json(transformedTrip);
  } catch (error) {
    console.error('Create trip error:', error);
    console.error('Error stack:', error.stack);
    // If trip was created but response failed, still return success
    try {
      const existingTrip = await Trip.findOne({ lrNumber: req.body.lrNumber });
      if (existingTrip) {
        // Trip was created, return it even if there was an error
        const basicTrip = {
          ...existingTrip.toObject(),
          id: existingTrip._id,
          agentId: req.body.agentId,
          agent: 'Unknown',
        };
        return res.status(201).json(basicTrip);
      }
    } catch (checkError) {
      console.error('Error checking existing trip:', checkError);
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// @desc    Update trip
// @route   PUT /api/trips/:id
// @access  Public
const updateTrip = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // No permission checks - public access
    // Update allowed fields
    if (req.body.status !== undefined) {
      trip.status = req.body.status;
    }
    if (req.body.lrSheet !== undefined) {
      trip.lrSheet = req.body.lrSheet;
    }

    const updatedTrip = await trip.save();

    // Populate trip with error handling
    let populatedTrip;
    try {
      populatedTrip = await Trip.findById(updatedTrip._id)
        .populate('agent', 'name email phone branch _id')
        .populate('agentId', 'name email phone branch _id');
    } catch (populateError) {
      console.error('Populate error (non-critical):', populateError);
      populatedTrip = updatedTrip;
    }

    // Transform trip with error handling
    let transformedTrip;
    try {
      transformedTrip = transformTrip(populatedTrip);
    } catch (transformError) {
      console.error('Transform error (non-critical):', transformError);
      transformedTrip = {
        ...(populatedTrip.toObject ? populatedTrip.toObject() : populatedTrip),
        id: updatedTrip._id,
        agentId: updatedTrip.agent,
        agent: 'Unknown',
      };
    }

    // Create audit log (don't fail if this fails)
    try {
      const userId = req.body.userId || trip.agent || null;
      const userRole = req.body.userRole || 'Agent';
      await createAuditLog(
        userId,
        userRole,
        'Update Trip',
        'Trip',
        trip._id,
        {
          changes: req.body,
          previousStatus: trip.status,
        },
        req.ip
      );
    } catch (auditError) {
      console.error('Audit log error (non-critical):', auditError);
    }

    res.json(transformedTrip);
  } catch (error) {
    console.error('Update trip error:', error);
    console.error('Error stack:', error.stack);
    // If trip was updated but response failed, still return success
    try {
      const existingTrip = await Trip.findById(req.params.id);
      if (existingTrip) {
        const basicTrip = {
          ...existingTrip.toObject(),
          id: existingTrip._id,
          agentId: existingTrip.agent,
          agent: 'Unknown',
        };
        return res.json(basicTrip);
      }
    } catch (checkError) {
      console.error('Error checking existing trip:', checkError);
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// @desc    Delete trip
// @route   DELETE /api/trips/:id
// @access  Public
const deleteTrip = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // Create audit log before deleting
    const userId = req.body.userId || trip.agent || null;
    const userRole = req.body.userRole || 'Agent';
    await createAuditLog(
      userId,
      userRole,
      'Delete Trip',
      'Trip',
      trip._id,
      {
        lrNumber: trip.lrNumber,
        route: trip.route,
      },
      req.ip
    );

    await Trip.findByIdAndDelete(req.params.id);

    res.json({ message: 'Trip deleted successfully' });
  } catch (error) {
    console.error('Delete trip error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Add on-trip payment
// @route   POST /api/trips/:id/payments
// @access  Public
const addPayment = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // Check if trip is Active
    if (trip.status !== 'Active') {
      return res.status(400).json({ message: 'Mid-trip payments can only be added for Active trips' });
    }

    const { amount, reason, mode, bank, agentId, userRole, userId } = req.body;

    // Use agentId from body, or trip's agent
    const targetAgentId = agentId || trip.agent;
    const paymentAmount = parseFloat(amount);
    const isFinancePayment = userRole === 'Finance';

    const payment = {
      amount: paymentAmount,
      reason,
      mode: mode || 'Cash',
      bank: bank || (mode === 'Cash' ? 'Cash' : ''),
      addedBy: userId || targetAgentId, // Use userId if Finance, otherwise agentId
      addedByRole: userRole || 'Agent', // Store who made the payment
    };

    trip.onTripPayments.push(payment);

    // Recalculate balance
    const totalPayments = trip.onTripPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const totalDeductions = trip.deductions ? Object.entries(trip.deductions).reduce((sum, [key, val]) => {
      if (key === 'othersReason') return sum;
      return sum + (parseFloat(val) || 0);
    }, 0) : 0;
    const initialBalance = trip.freight - trip.advance;
    trip.balance = initialBalance - totalDeductions - totalPayments;
    trip.balanceAmount = trip.balance;

    await trip.save();

    // If Finance makes payment on behalf of agent, create TWO ledger entries
    if (isFinancePayment) {
      // Entry 1: Finance → Agent (Credit) - Top-up
      // Calculate agent's current balance before adding credit
      const agentLedger = await Ledger.find({ agent: targetAgentId });
      const agentBalance = agentLedger.reduce((sum, entry) => {
        if (entry.direction === 'Credit') {
          return sum + (entry.amount || 0);
        } else {
          return sum - (entry.amount || 0);
        }
      }, 0);

      await Ledger.create({
        tripId: trip._id,
        lrNumber: trip.lrNumber,
        date: new Date(),
        description: `Top-up: Top up`,
        type: 'Top-up',
        amount: paymentAmount,
        advance: 0,
        balance: agentBalance + paymentAmount,
        agent: targetAgentId,
        agentId: targetAgentId,
        bank: bank || (mode === 'Cash' ? 'Cash' : 'HDFC Bank'),
        direction: 'Credit',
        paymentMadeBy: 'Finance', // Mark as Finance payment
      });

      // Entry 2: Agent → Trip Expense (Debit) - On-Trip Payment
      await Ledger.create({
        tripId: trip._id,
        lrNumber: trip.lrNumber,
        date: new Date(),
        description: `On-trip payment: ${reason}`,
        type: 'On-Trip Payment',
        amount: paymentAmount,
        advance: 0,
        balance: trip.balance,
        agent: targetAgentId,
        agentId: targetAgentId,
        bank: bank || (mode === 'Cash' ? 'Cash' : 'HDFC Bank'),
        direction: 'Debit',
        paymentMadeBy: 'Finance', // Mark as Finance payment
      });
    } else {
      // Agent makes payment - only create debit entry (existing behavior)
      await Ledger.create({
        tripId: trip._id,
        lrNumber: trip.lrNumber,
        date: new Date(),
        description: `On-trip payment: ${reason}`,
        type: 'On-Trip Payment',
        amount: paymentAmount,
        advance: 0,
        balance: trip.balance,
        agent: targetAgentId,
        agentId: targetAgentId,
        bank: bank || (mode === 'Cash' ? 'Cash' : 'HDFC Bank'),
        direction: 'Debit',
        paymentMadeBy: 'Agent', // Mark as Agent payment
      });
    }

    // Populate trip with error handling
    let populatedTrip;
    try {
      populatedTrip = await Trip.findById(trip._id)
        .populate('agent', 'name email phone branch _id')
        .populate('agentId', 'name email phone branch _id')
        .populate('onTripPayments.addedBy', 'name role _id');
    } catch (populateError) {
      console.error('Populate error (non-critical):', populateError);
      // If populate fails, use trip without populate
      populatedTrip = trip;
    }

    // Transform trip with error handling
    let transformedTrip;
    try {
      transformedTrip = transformTrip(populatedTrip);
    } catch (transformError) {
      console.error('Transform error (non-critical):', transformError);
      // If transform fails, send basic trip data
      transformedTrip = {
        ...(populatedTrip.toObject ? populatedTrip.toObject() : populatedTrip),
        id: trip._id,
        agentId: targetAgentId,
        agent: 'Unknown',
      };
    }

    // Create audit log (don't fail if this fails)
    try {
      await createAuditLog(
        userId || targetAgentId,
        userRole || 'Agent',
        'Add Payment',
        'Trip',
        trip._id,
        {
          amount: paymentAmount,
          reason,
          mode,
          lrNumber: trip.lrNumber,
          isFinancePayment,
        },
        req.ip
      );
    } catch (auditError) {
      console.error('Audit log error (non-critical):', auditError);
      // Continue even if audit log fails
    }

    res.json(transformedTrip);
  } catch (error) {
    console.error('Add payment error:', error);
    console.error('Error stack:', error.stack);
    // If payment was added but response failed, still return success
    try {
      const existingTrip = await Trip.findById(req.params.id);
      if (existingTrip && existingTrip.onTripPayments.length > 0) {
        // Payment was added, return trip even if there was an error
        const basicTrip = {
          ...existingTrip.toObject(),
          id: existingTrip._id,
          agentId: targetAgentId || existingTrip.agent,
          agent: 'Unknown',
        };
        return res.json(basicTrip);
      }
    } catch (checkError) {
      console.error('Error checking existing trip:', checkError);
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// @desc    Update deductions
// @route   PUT /api/trips/:id/deductions
// @access  Public
const updateDeductions = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // Can only update deductions for Active trips
    if (trip.status === 'Completed') {
      return res.status(400).json({ message: 'Cannot update deductions for completed trips' });
    }

    trip.deductions = { ...trip.deductions, ...req.body };

    // Recalculate balance
    const totalDeductions = Object.entries(trip.deductions).reduce((sum, [key, val]) => {
      if (key === 'othersReason') return sum;
      return sum + (parseFloat(val) || 0);
    }, 0);
    const totalPayments = trip.onTripPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const initialBalance = trip.freight - trip.advance;
    trip.balance = initialBalance - totalDeductions - totalPayments;
    trip.balanceAmount = trip.balance;

    await trip.save();

    // Populate trip with error handling
    let populatedTrip;
    try {
      populatedTrip = await Trip.findById(trip._id)
        .populate('agent', 'name email phone branch _id')
        .populate('agentId', 'name email phone branch _id');
    } catch (populateError) {
      console.error('Populate error (non-critical):', populateError);
      populatedTrip = trip;
    }

    // Transform trip with error handling
    let transformedTrip;
    try {
      transformedTrip = transformTrip(populatedTrip);
    } catch (transformError) {
      console.error('Transform error (non-critical):', transformError);
      transformedTrip = {
        ...(populatedTrip.toObject ? populatedTrip.toObject() : populatedTrip),
        id: trip._id,
        agentId: trip.agent,
        agent: 'Unknown',
      };
    }

    // Create audit log (don't fail if this fails)
    try {
      const userId = req.body.userId || trip.agent || null;
      const userRole = req.body.userRole || 'Agent';
      await createAuditLog(
        userId,
        userRole,
        'Update Deductions',
        'Trip',
        trip._id,
        {
          deductions: req.body,
          lrNumber: trip.lrNumber,
        },
        req.ip
      );
    } catch (auditError) {
      console.error('Audit log error (non-critical):', auditError);
    }

    res.json(transformedTrip);
  } catch (error) {
    console.error('Update deductions error:', error);
    console.error('Error stack:', error.stack);
    // If trip was updated but response failed, still return success
    try {
      const existingTrip = await Trip.findById(req.params.id);
      if (existingTrip) {
        const basicTrip = {
          ...existingTrip.toObject(),
          id: existingTrip._id,
          agentId: existingTrip.agent,
          agent: 'Unknown',
        };
        return res.json(basicTrip);
      }
    } catch (checkError) {
      console.error('Error checking existing trip:', checkError);
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// @desc    Close trip
// @route   POST /api/trips/:id/close
// @access  Public
const closeTrip = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // Check if trip has open dispute
    const openDispute = await Dispute.findOne({ 
      tripId: trip._id, 
      status: 'Open' 
    });

    // Allow force close if forceClose flag is set (for Admin)
    const { forceClose } = req.body;
    if (openDispute && !forceClose) {
      return res.status(400).json({ message: 'Cannot close trip with open dispute. Use forceClose=true for Admin override.' });
    }

    // Handle Bulk trips - mark as Completed directly
    if (trip.isBulk) {
      trip.status = 'Completed';
      trip.closedAt = new Date();
      trip.closedBy = trip.agent; // Use trip's agent
      await trip.save();
      
      // Populate trip with error handling
      let populatedTrip;
      try {
        populatedTrip = await Trip.findById(trip._id)
          .populate('agent', 'name email phone branch _id')
          .populate('agentId', 'name email phone branch _id');
      } catch (populateError) {
        console.error('Populate error (non-critical):', populateError);
        populatedTrip = trip;
      }

      // Transform trip with error handling
      let transformedTrip;
      try {
        transformedTrip = transformTrip(populatedTrip);
      } catch (transformError) {
        console.error('Transform error (non-critical):', transformError);
        transformedTrip = {
          ...(populatedTrip.toObject ? populatedTrip.toObject() : populatedTrip),
          id: trip._id,
          agentId: trip.agent,
          agent: 'Unknown',
        };
      }

      return res.json(transformedTrip);
    }

    // For Regular trips - calculate final balance
    const deductions = trip.deductions || {};
    const betaAmount = parseFloat(deductions.beta) || 0;

    // Calculate total deductions excluding Beta/Batta
    const totalDeductions = Object.entries(deductions).reduce((sum, [key, val]) => {
      if (key === 'othersReason' || key === 'beta') return sum;
      return sum + (parseFloat(val) || 0);
    }, 0);

    // Separate Finance payments from Agent payments
    // Finance payments are already credited to agent wallet, so don't deduct from finalBalance
    const agentPayments = trip.onTripPayments
      .filter(p => p.addedByRole !== 'Finance')
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    
    const financePayments = trip.onTripPayments
      .filter(p => p.addedByRole === 'Finance')
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    
    const totalPayments = trip.onTripPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const initialBalance = trip.freight - trip.advance;
    
    // Final balance calculation:
    // initialBalance - deductions - agentPayments
    // Finance payments are NOT deducted because they're already credited to agent wallet
    // Finance payments should INCREASE the final settlement amount
    const finalBalance = initialBalance - totalDeductions - agentPayments + financePayments;

    trip.status = 'Completed';
    trip.finalBalance = finalBalance;
    trip.closedAt = new Date();
    trip.closedBy = trip.agent; // Use trip's agent
    await trip.save();

    // Create final settlement ledger entry
    await Ledger.create({
      tripId: trip._id,
      lrNumber: trip.lrNumber,
      date: new Date(),
      description: `Trip closed - Final settlement for ${trip.lrNumber}`,
      type: 'Trip Closed',
      amount: finalBalance,
      advance: 0,
      balance: 0,
      agent: trip.agent,
      agentId: trip.agent,
      bank: 'HDFC Bank',
      direction: 'Debit',
    });

    // Beta/Batta Credit Back
    if (betaAmount > 0) {
      const agentLedger = await Ledger.find({ agent: trip.agent });
      const agentBalance = agentLedger.reduce((sum, entry) => {
        if (entry.direction === 'Credit') {
          return sum + (entry.amount || 0);
        } else {
          return sum - (entry.amount || 0);
        }
      }, 0);

      await Ledger.create({
        tripId: trip._id,
        lrNumber: trip.lrNumber,
        date: new Date(),
        description: `Beta/Batta credited back for ${trip.lrNumber}`,
        type: 'Beta/Batta Credit',
        amount: betaAmount,
        advance: 0,
        balance: agentBalance + betaAmount,
        agent: trip.agent,
        agentId: trip.agent,
        bank: 'HDFC Bank',
        direction: 'Credit',
      });
    }

    // Populate trip with error handling
    let populatedTrip;
    try {
      populatedTrip = await Trip.findById(trip._id)
        .populate('agent', 'name email phone branch _id')
        .populate('agentId', 'name email phone branch _id');
    } catch (populateError) {
      console.error('Populate error (non-critical):', populateError);
      populatedTrip = trip;
    }

    // Transform trip with error handling
    let transformedTrip;
    try {
      transformedTrip = transformTrip(populatedTrip);
    } catch (transformError) {
      console.error('Transform error (non-critical):', transformError);
      transformedTrip = {
        ...(populatedTrip.toObject ? populatedTrip.toObject() : populatedTrip),
        id: trip._id,
        agentId: trip.agent,
        agent: 'Unknown',
      };
    }

    // Create audit log (don't fail if this fails)
    try {
      const userId = req.body.userId || trip.agent || null;
      const userRole = req.body.userRole || 'Agent';
      await createAuditLog(
        userId,
        userRole,
        'Close Trip',
        'Trip',
        trip._id,
        {
          lrNumber: trip.lrNumber,
          finalBalance,
          forceClose: forceClose || false,
        },
        req.ip
      );
    } catch (auditError) {
      console.error('Audit log error (non-critical):', auditError);
    }

    res.json(transformedTrip);
  } catch (error) {
    console.error('Close trip error:', error);
    console.error('Error stack:', error.stack);
    // If trip was closed but response failed, still return success
    try {
      const existingTrip = await Trip.findById(req.params.id);
      if (existingTrip && existingTrip.status === 'Completed') {
        // Trip was closed, return it even if there was an error
        const basicTrip = {
          ...existingTrip.toObject(),
          id: existingTrip._id,
          agentId: existingTrip.agent,
          agent: 'Unknown',
        };
        return res.json(basicTrip);
      }
    } catch (checkError) {
      console.error('Error checking existing trip:', checkError);
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// @desc    Add attachment
// @route   POST /api/trips/:id/attachments
// @access  Public
const addAttachment = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // Check max 4 files limit
    if (trip.attachments.length >= 4) {
      return res.status(400).json({ message: 'Maximum 4 attachments allowed per trip' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { uploadedBy } = req.body; // Get uploadedBy from body

    const attachment = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      uploadedBy: uploadedBy || trip.agent, // Use uploadedBy from body or trip's agent
    };

    trip.attachments.push(attachment);
    await trip.save();

    const populatedTrip = await Trip.findById(trip._id)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .populate('attachments.uploadedBy', 'name role _id');

    res.json(transformTrip(populatedTrip));
  } catch (error) {
    console.error('Add attachment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Delete attachment
// @route   DELETE /api/trips/:id/attachments/:attachmentId
// @access  Private/Finance, Admin
const deleteAttachment = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    trip.attachments = trip.attachments.filter(
      att => att._id.toString() !== req.params.attachmentId
    );

    await trip.save();

    const populatedTrip = await Trip.findById(trip._id)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .populate('attachments.uploadedBy', 'name role _id');

    res.json(transformTrip(populatedTrip));
  } catch (error) {
    console.error('Delete attachment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getTrips,
  getTrip,
  createTrip,
  updateTrip,
  deleteTrip,
  addPayment,
  updateDeductions,
  closeTrip,
  addAttachment,
  deleteAttachment,
};

