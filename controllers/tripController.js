const Trip = require('../models/Trip');
const Ledger = require('../models/Ledger');
const Dispute = require('../models/Dispute');
const User = require('../models/User');
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
      try {
        const ledgerEntry = await Ledger.create({
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
        console.log('Ledger entry created successfully:', {
          id: ledgerEntry._id,
          type: ledgerEntry.type,
          amount: ledgerEntry.amount,
          lrNumber: ledgerEntry.lrNumber,
          agentId: ledgerEntry.agentId
        });
      } catch (ledgerError) {
        console.error('Error creating ledger entry for trip:', ledgerError);
        // Don't fail the trip creation if ledger entry fails
        // But log it for debugging
      }
    } else if (!isBulk && advance === 0) {
      console.log('No ledger entry created: advance is 0 or trip is bulk');
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

    // IMPORTANT: Payment should be deducted from the agent who is making the payment, NOT the trip creator
    // Rule: 
    // - If Finance is adding payment: Use agentId from body (selected agent)
    // - If Agent is adding payment: Use userId (logged-in agent making the payment)
    // - Fallback: trip.agent (only if agentId and userId both not available)
    let targetAgentId;
    if (userRole === 'Finance') {
      // Finance payment: Use selected agent from dropdown
      if (!agentId) {
        return res.status(400).json({ message: 'Agent selection is required for Finance payments' });
      }
      targetAgentId = agentId;
    } else {
      // Agent payment: Use logged-in agent (who is making the payment)
      if (!userId) {
        return res.status(400).json({ message: 'User ID is required for Agent payments' });
      }
      targetAgentId = userId;
    }
    
    const paymentAmount = parseFloat(amount);
    const isFinancePayment = userRole === 'Finance';
    
    console.log(`Adding payment: LR ${trip.lrNumber}, Amount ${paymentAmount}, UserRole ${userRole}, Passed agentId ${agentId}, UserId ${userId}, Trip agent ${trip.agent}, Using targetAgentId ${targetAgentId} (payment will be deducted from this agent's account)`);

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
      try {
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
        console.log(`Ledger entry created for Finance Credit (Top-up): LR ${trip.lrNumber}, Amount ${paymentAmount}, Agent ${targetAgentId}`);

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
        console.log(`Ledger entry created for Finance Debit (On-Trip Payment): LR ${trip.lrNumber}, Amount ${paymentAmount}, Agent ${targetAgentId}`);
      } catch (ledgerError) {
        console.error(`Error creating ledger entries for Finance payment (non-critical): LR ${trip.lrNumber}, Agent ${targetAgentId}, Error:`, ledgerError);
        // Continue even if ledger entry creation fails - trip payment is already saved
      }
    } else {
      // Agent makes payment - create debit entry for payment maker AND informational entry for trip creator
      try {
        // Entry 1: Payment maker's account - Debit (balance affected)
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
        console.log(`Ledger entry created for Agent On-Trip Payment (Payment Maker): LR ${trip.lrNumber}, Amount ${paymentAmount}, Agent ${targetAgentId}`);
        
        // Entry 2: Trip creator's account - Informational entry (if different from payment maker)
        const tripCreatorId = trip.agent || trip.agentId;
        if (tripCreatorId && String(tripCreatorId) !== String(targetAgentId)) {
          // Calculate trip creator's balance (don't affect it, just show reference)
          const tripCreatorLedger = await Ledger.find({ agent: tripCreatorId });
          const tripCreatorBalance = tripCreatorLedger.reduce((sum, entry) => {
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
            description: `On-trip payment (by another agent): ${reason}`,
            type: 'On-Trip Payment',
            amount: paymentAmount,
            advance: 0,
            balance: tripCreatorBalance, // No change to balance, just informational
            agent: tripCreatorId,
            agentId: tripCreatorId,
            bank: bank || (mode === 'Cash' ? 'Cash' : 'HDFC Bank'),
            direction: 'Debit',
            paymentMadeBy: 'Agent', // Mark as Agent payment
            isInformational: true, // Flag to indicate this entry is informational only (balance not affected)
          });
          console.log(`Ledger entry created for Trip Creator (Informational): LR ${trip.lrNumber}, Amount ${paymentAmount}, Trip Creator ${tripCreatorId}`);
        }
      } catch (ledgerError) {
        console.error(`Error creating ledger entries for Agent On-Trip Payment (non-critical): LR ${trip.lrNumber}, Agent ${targetAgentId}, Error:`, ledgerError);
        // Continue even if ledger entry creation fails - trip payment is already saved
      }
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

    // Store old deductions to calculate difference
    const oldDeductions = trip.deductions || {};
    const oldTotalDeductions = Object.entries(oldDeductions).reduce((sum, [key, val]) => {
      if (key === 'othersReason' || key === 'addedBy' || key === 'addedByRole') return sum;
      return sum + (parseFloat(val) || 0);
    }, 0);

    trip.deductions = { ...trip.deductions, ...req.body };

    // Recalculate balance
    const totalDeductions = Object.entries(trip.deductions).reduce((sum, [key, val]) => {
      if (key === 'othersReason' || key === 'addedBy' || key === 'addedByRole') return sum;
      return sum + (parseFloat(val) || 0);
    }, 0);
    const totalPayments = trip.onTripPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const initialBalance = trip.freight - trip.advance;
    trip.balance = initialBalance - totalDeductions - totalPayments;
    trip.balanceAmount = trip.balance;

    await trip.save();

    // Create ledger entry for agent who added deductions (whenever deductions are saved)
    // Get who added the deductions - prioritize req.body (current save) over existing trip data
    const deductionsAddedBy = req.body.addedBy || trip.deductions?.addedBy || trip.agent;
    const deductionsAddedByRole = req.body.addedByRole || trip.deductions?.addedByRole || 'Agent';
    
    // Always create/update ledger entry when deductions are saved (even if updating existing deductions)
    // This ensures the agent who saved deductions gets the entry in their ledger
    if (totalDeductions > 0 && deductionsAddedBy) {
      try {
        // Check if there's already a Settlement entry for this trip and agent (to avoid duplicates)
        const existingEntry = await Ledger.findOne({
          tripId: trip._id,
          agent: deductionsAddedBy,
          type: 'Settlement',
          // Only check entries created before trip closure (not the ones created during closeTrip)
          // We can identify them by checking if trip is still Active
        });

        // Always create/update entry when deductions are saved (for Active trips)
        if (trip.status === 'Active') {
          // Get agent name who added deductions
          const deductionsAddedByUser = await User.findById(deductionsAddedBy);
          const deductionsAddedByName = deductionsAddedByUser?.name || 'Unknown Agent';

          // If entry exists, update it; otherwise create new
          if (existingEntry) {
            // Store old amount to adjust balance calculation
            const oldAmount = existingEntry.amount || 0;
            
            // Update existing entry with new total deductions
            existingEntry.amount = totalDeductions;
            existingEntry.description = `Closing deductions added for ${trip.lrNumber} by ${deductionsAddedByName} (Cess: ${trip.deductions.cess || 0}, Kata: ${trip.deductions.kata || 0}, Expenses: ${trip.deductions.expenses || 0}, Others: ${trip.deductions.others || 0})`;
            existingEntry.deductionsAddedBy = deductionsAddedBy;
            existingEntry.paymentMadeBy = deductionsAddedByRole;
            await existingEntry.save();
            
            // Recalculate balance AFTER updating entry
            const deductionsAgentLedger = await Ledger.find({ agent: deductionsAddedBy });
            const deductionsAgentBalance = deductionsAgentLedger.reduce((sum, entry) => {
              if (entry.direction === 'Credit') {
                return sum + (entry.amount || 0);
              } else {
                return sum - (entry.amount || 0);
              }
            }, 0);
            
            // Update balance field
            existingEntry.balance = deductionsAgentBalance;
            await existingEntry.save();
            
            console.log(`Ledger entry updated for Closing Deductions: LR ${trip.lrNumber}, Amount ${totalDeductions}, Added by ${deductionsAddedBy} (${deductionsAddedByName}), Balance: ${deductionsAgentBalance}`);
          } else {
            // Get agent's current balance BEFORE creating entry
            const deductionsAgentLedger = await Ledger.find({ agent: deductionsAddedBy });
            const deductionsAgentBalance = deductionsAgentLedger.reduce((sum, entry) => {
              if (entry.direction === 'Credit') {
                return sum + (entry.amount || 0);
              } else {
                return sum - (entry.amount || 0);
              }
            }, 0);

            // Create new entry
            await Ledger.create({
              tripId: trip._id,
              lrNumber: trip.lrNumber,
              date: new Date(),
              description: `Closing deductions added for ${trip.lrNumber} by ${deductionsAddedByName} (Cess: ${trip.deductions.cess || 0}, Kata: ${trip.deductions.kata || 0}, Expenses: ${trip.deductions.expenses || 0}, Others: ${trip.deductions.others || 0})`,
              type: 'Settlement',
              amount: totalDeductions,
              advance: 0,
              balance: deductionsAgentBalance - totalDeductions, // Balance after deducting this amount
              agent: deductionsAddedBy,
              agentId: deductionsAddedBy,
              bank: 'HDFC Bank',
              direction: 'Debit',
              paymentMadeBy: deductionsAddedByRole,
              deductionsAddedBy: deductionsAddedBy,
              // NOT informational - balance WILL be affected
            });
            console.log(`Ledger entry created for Closing Deductions (on save): LR ${trip.lrNumber}, Amount ${totalDeductions}, Added by ${deductionsAddedBy} (${deductionsAddedByName}), Balance: ${deductionsAgentBalance - totalDeductions}`);
          }
        }
      } catch (ledgerError) {
        console.error(`Error creating ledger entry for Closing Deductions (non-critical): LR ${trip.lrNumber}, Error:`, ledgerError);
      }
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

    const { forceClose, closedBy, closedByRole } = req.body;
    const tripCreatorId = trip.agent || trip.agentId;

    // Validation: Trip creator cannot close trip (only for Agents)
    if (closedByRole === 'Agent' && closedBy && tripCreatorId && 
        String(closedBy).trim() === String(tripCreatorId).trim()) {
      return res.status(400).json({ message: 'Trip creator cannot close the trip. Another agent must close it.' });
    }

    // Check if trip has open dispute
    const openDispute = await Dispute.findOne({ 
      tripId: trip._id, 
      status: 'Open' 
    });

    // Allow force close if forceClose flag is set (for Admin/Finance)
    if (openDispute && !forceClose) {
      return res.status(400).json({ message: 'Cannot close trip with open dispute. Use forceClose=true for Admin/Finance override.' });
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

    // Validation: Agent can only close when finalBalance === 0
    // If finalBalance > 0, closing agent must have enough balance to pay
    if (closedByRole === 'Agent' && Math.abs(finalBalance) > 0.01) {
      if (finalBalance > 0.01) {
        // Need to pay final amount - check closing agent's balance
        const closingAgentLedger = await Ledger.find({ agent: closedBy });
        const closingAgentBalance = closingAgentLedger.reduce((sum, entry) => {
          if (entry.direction === 'Credit') {
            return sum + (entry.amount || 0);
          } else {
            return sum - (entry.amount || 0);
          }
        }, 0);
        
        if (closingAgentBalance < finalBalance) {
          return res.status(400).json({ 
            message: `Your balance (Rs ${closingAgentBalance.toLocaleString()}) is not enough to close this trip. Required: Rs ${finalBalance.toLocaleString()}` 
          });
        }
        // If balance is enough, agent should pay final amount first (handled by frontend)
        return res.status(400).json({ 
          message: `Cannot close trip. Final balance must be 0. Please pay Rs ${finalBalance.toLocaleString()} first.` 
        });
      } else {
        // Negative balance (shouldn't happen, but handle it)
        return res.status(400).json({ 
          message: `Cannot close trip. Final balance must be 0. Current balance: Rs ${finalBalance.toLocaleString()}` 
        });
      }
    }

    // Get who added closing deductions
    const deductionsAddedBy = deductions.addedBy || trip.agent;
    const deductionsAddedByRole = deductions.addedByRole || 'Agent';
    // tripCreatorId already declared above (line 774)

    // Create ledger entries for closing deductions (if any deductions were added)
    // Note: Entry for agent who added deductions is already created in updateDeductions
    // Here we only create entry for trip creator (if different from agent who added deductions)
    if (totalDeductions > 0) {
      try {
        // Get agent name who added deductions for description
        const deductionsAddedByUser = await User.findById(deductionsAddedBy);
        const deductionsAddedByName = deductionsAddedByUser?.name || 'Unknown Agent';

        // Entry 1: Trip creator's account - Debit (actual deduction)
        // Only create if trip creator is different from agent who added deductions
        // (If same, the entry was already created in updateDeductions)
        if (String(tripCreatorId).trim() !== String(deductionsAddedBy).trim()) {
          // Check if entry already exists for trip creator
          const existingTripCreatorEntry = await Ledger.findOne({
            tripId: trip._id,
            agent: tripCreatorId,
            type: 'Settlement',
          });

          if (!existingTripCreatorEntry) {
            const tripCreatorLedger = await Ledger.find({ agent: tripCreatorId });
            const tripCreatorBalance = tripCreatorLedger.reduce((sum, entry) => {
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
              description: `Closing deductions added by ${deductionsAddedByName} for ${trip.lrNumber} (Cess: ${deductions.cess || 0}, Kata: ${deductions.kata || 0}, Expenses: ${deductions.expenses || 0}, Others: ${deductions.others || 0})`,
              type: 'Settlement',
              amount: totalDeductions,
              advance: 0,
              balance: tripCreatorBalance - totalDeductions,
              agent: tripCreatorId, // Debit trip creator's account
              agentId: tripCreatorId,
              bank: 'HDFC Bank',
              direction: 'Debit',
              paymentMadeBy: deductionsAddedByRole, // Track who added deductions (for display in Finance ledger)
              deductionsAddedBy: deductionsAddedBy, // Store who added deductions
            });
            console.log(`Ledger entry created for Closing Deductions (Trip Creator): LR ${trip.lrNumber}, Amount ${totalDeductions}, Trip Creator ${tripCreatorId}`);
          }
        }

        // Entry 2: Agent who added deductions - Entry already created in updateDeductions
        // Just verify it exists and update balance if needed
        if (deductionsAddedBy) {
          const existingDeductionsEntry = await Ledger.findOne({
            tripId: trip._id,
            agent: deductionsAddedBy,
            type: 'Settlement',
          });

          if (existingDeductionsEntry) {
            // Entry already exists (created in updateDeductions), just update balance
            const deductionsAgentLedger = await Ledger.find({ agent: deductionsAddedBy });
            const deductionsAgentBalance = deductionsAgentLedger.reduce((sum, entry) => {
              if (entry.direction === 'Credit') {
                return sum + (entry.amount || 0);
              } else {
                return sum - (entry.amount || 0);
              }
            }, 0);
            
            existingDeductionsEntry.balance = deductionsAgentBalance;
            await existingDeductionsEntry.save();
            console.log(`Ledger entry balance updated for Closing Deductions (Added By Agent): LR ${trip.lrNumber}, Agent ${deductionsAddedBy}, Balance: ${deductionsAgentBalance}`);
          } else {
            // Entry doesn't exist (shouldn't happen, but create it as fallback)
            const deductionsAgentLedger = await Ledger.find({ agent: deductionsAddedBy });
            const deductionsAgentBalance = deductionsAgentLedger.reduce((sum, entry) => {
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
              description: `Closing deductions added for ${trip.lrNumber} by ${deductionsAddedByName} (Cess: ${deductions.cess || 0}, Kata: ${deductions.kata || 0}, Expenses: ${deductions.expenses || 0}, Others: ${deductions.others || 0})`,
              type: 'Settlement',
              amount: totalDeductions,
              advance: 0,
              balance: deductionsAgentBalance - totalDeductions,
              agent: deductionsAddedBy,
              agentId: deductionsAddedBy,
              bank: 'HDFC Bank',
              direction: 'Debit',
              paymentMadeBy: deductionsAddedByRole,
              deductionsAddedBy: deductionsAddedBy,
            });
            console.log(`Ledger entry created for Closing Deductions (Added By Agent - Fallback): LR ${trip.lrNumber}, Amount ${totalDeductions}, Added by ${deductionsAddedBy} (${deductionsAddedByName}), Balance: ${deductionsAgentBalance - totalDeductions}`);
          }
        }
      } catch (ledgerError) {
        console.error(`Error creating ledger entries for Closing Deductions (non-critical): LR ${trip.lrNumber}, Error:`, ledgerError);
      }
    }

    trip.status = 'Completed';
    trip.finalBalance = finalBalance;
    trip.closedAt = new Date();
    trip.closedBy = closedBy || trip.agent; // Store who closed the trip
    await trip.save();

    // Create final settlement ledger entry (Trip Closed)
    // This entry goes to the agent who closed the trip (not trip creator)
    const closingAgentId = closedBy || trip.agent;
    try {
      const closingAgentLedger = await Ledger.find({ agent: closingAgentId });
      const closingAgentBalance = closingAgentLedger.reduce((sum, entry) => {
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
        description: `Trip closed - Final settlement for ${trip.lrNumber} (Closed by: ${closedByRole || 'Agent'})`,
        type: 'Trip Closed',
        amount: finalBalance,
        advance: 0,
        balance: closingAgentBalance, // No change to balance (informational only)
        agent: closingAgentId,
        agentId: closingAgentId,
        bank: 'HDFC Bank',
        direction: 'Debit',
        paymentMadeBy: closedByRole || 'Agent', // Track who closed the trip
        isInformational: true, // Mark as informational (balance not affected)
      });
      console.log(`Ledger entry created for Trip Closed: LR ${trip.lrNumber}, Amount ${finalBalance}, Closed by ${closingAgentId}`);
    } catch (ledgerError) {
      console.error(`Error creating ledger entry for Trip Closed (non-critical): LR ${trip.lrNumber}, Error:`, ledgerError);
    }

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

