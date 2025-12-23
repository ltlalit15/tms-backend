const Trip = require('../models/Trip');
const Ledger = require('../models/Ledger');
const Dispute = require('../models/Dispute');
const User = require('../models/User');

// @desc    Get dashboard stats
// @route   GET /api/reports/dashboard
// @access  Public
const getDashboardStats = async (req, res) => {
  try {
    const { agentId, branchId } = req.query; // Optional filters
    let tripQuery = {};
    let ledgerQuery = {};
    let disputeQuery = {};

    // No role-based filtering - use query params if provided
    if (agentId) {
      tripQuery.agent = agentId;
      ledgerQuery.agent = agentId;
      disputeQuery.agent = agentId;
    }
    if (branchId) {
      tripQuery.branch = branchId;
    }

    // Trip stats
    const activeTrips = await Trip.countDocuments({ ...tripQuery, status: 'Active' });
    const completedTrips = await Trip.countDocuments({ ...tripQuery, status: 'Completed' });
    const disputedTrips = await Trip.countDocuments({ 
      ...tripQuery, 
      status: { $in: ['In Dispute', 'Dispute'] } 
    });
    const totalTrips = await Trip.countDocuments(tripQuery);

    // Ledger stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayLedger = await Ledger.find({
      ...ledgerQuery,
      createdAt: { $gte: today },
    });

    const dailyTopUps = todayLedger
      .filter(l => l.type === 'Top-up')
      .reduce((sum, l) => sum + l.amount, 0);

    const dailyPayments = todayLedger
      .filter(l => l.type === 'On-Trip Payment')
      .reduce((sum, l) => sum + l.amount, 0);

    // Bank-wise spend (always included)
    const bankWiseSpend = {};
    const allLedger = await Ledger.find({ direction: 'Debit' });
    allLedger.forEach(entry => {
      const bank = entry.bank || 'Cash';
      bankWiseSpend[bank] = (bankWiseSpend[bank] || 0) + entry.amount;
    });

    // Dispute stats
    const openDisputes = await Dispute.countDocuments({ ...disputeQuery, status: 'Open' });
    const resolvedDisputes = await Dispute.countDocuments({ ...disputeQuery, status: 'Resolved' });

    res.json({
      trips: {
        active: activeTrips,
        completed: completedTrips,
        disputed: disputedTrips,
        total: totalTrips,
      },
      ledger: {
        dailyTopUps,
        dailyPayments,
        bankWiseSpend,
      },
      disputes: {
        open: openDisputes,
        resolved: resolvedDisputes,
      },
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get trip report
// @route   GET /api/reports/trips
// @access  Public
const getTripReport = async (req, res) => {
  try {
    const { startDate, endDate, agentId, branch, status } = req.query;
    let query = {};

    // No role-based filtering - use query params
    if (agentId) {
      query.agent = agentId;
    }
    if (branch) {
      query.branch = branch;
    }
    if (status) {
      query.status = status;
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    const trips = await Trip.find(query)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .sort({ createdAt: -1 });

    // Transform trips
    const transformedTrips = trips.map(trip => ({
      ...trip.toObject(),
      id: trip._id,
      agentId: trip.agent?._id || trip.agentId?._id || trip.agentId,
      agent: trip.agent?.name || trip.agentId?.name || trip.agent,
    }));

    res.json(transformedTrips);
  } catch (error) {
    console.error('Get trip report error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get ledger report
// @route   GET /api/reports/ledger
// @access  Public
const getLedgerReport = async (req, res) => {
  try {
    const { startDate, endDate, agentId, bank } = req.query;
    let query = {};

    // No role-based filtering - use query params
    if (agentId) {
      query.agent = agentId;
    }
    if (bank) {
      query.bank = bank;
    }
    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
      }
    }

    const ledger = await Ledger.find(query)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .populate('tripId', 'lrNumber route _id')
      .sort({ date: -1 });

    // Transform ledger
    const transformedLedger = ledger.map(entry => ({
      ...entry.toObject(),
      id: entry._id,
      agentId: entry.agent?._id || entry.agentId?._id || entry.agentId,
      agent: entry.agent?.name || entry.agentId?.name || entry.agent,
    }));

    res.json(transformedLedger);
  } catch (error) {
    console.error('Get ledger report error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get agent performance report
// @route   GET /api/reports/agents
// @access  Public
const getAgentPerformanceReport = async (req, res) => {
  try {
    const agents = await User.find({ role: 'Agent' });
    const performance = [];

    for (const agent of agents) {
      const trips = await Trip.find({ agent: agent._id });
      const ledger = await Ledger.find({ agent: agent._id });

      const balance = ledger.reduce((sum, entry) => {
        if (entry.direction === 'Credit') {
          return sum + (entry.amount || 0);
        } else {
          return sum - (entry.amount || 0);
        }
      }, 0);

      performance.push({
        agent: {
          _id: agent._id,
          id: agent._id,
          name: agent.name,
          email: agent.email,
          phone: agent.phone,
          branch: agent.branch,
        },
        stats: {
          totalTrips: trips.length,
          activeTrips: trips.filter(t => t.status === 'Active').length,
          completedTrips: trips.filter(t => t.status === 'Completed').length,
          disputedTrips: trips.filter(t => t.status === 'In Dispute').length,
          totalFreight: trips.reduce((sum, t) => sum + (t.freight || 0), 0),
          currentBalance: balance,
        },
      });
    }

    res.json(performance);
  } catch (error) {
    console.error('Get agent performance report error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getDashboardStats,
  getTripReport,
  getLedgerReport,
  getAgentPerformanceReport,
};

