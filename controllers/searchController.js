const Trip = require('../models/Trip');
const Ledger = require('../models/Ledger');

// @desc    Global LR search - search across all trips and ledger entries
// @route   GET /api/search/lr/:lrNumber
// @access  Public (all users can search any LR)
const globalLRSearch = async (req, res) => {
  try {
    const { lrNumber } = req.params;
    const { companyName } = req.query; // Optional company name filter

    if (!lrNumber || lrNumber.trim() === '') {
      return res.status(400).json({ message: 'LR number is required' });
    }

    const searchTerm = lrNumber.trim();

    // Build query for trips - search by LR number and optionally by company name
    let tripQuery = {
      $or: [
        { lrNumber: { $regex: searchTerm, $options: 'i' } },
        { tripId: { $regex: searchTerm, $options: 'i' } },
      ],
    };

    // Add company name filter if provided
    if (companyName && companyName.trim() !== '') {
      tripQuery.companyName = { $regex: companyName.trim(), $options: 'i' };
    }

    // Search trips globally (no role-based filtering)
    const trips = await Trip.find(tripQuery)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .sort({ createdAt: -1 })
      .limit(50);

    // Build query for ledger entries
    let ledgerQuery = {
      $or: [
        { lrNumber: { $regex: searchTerm, $options: 'i' } },
        { tripId: { $regex: searchTerm, $options: 'i' } },
      ],
    };

    // Search ledger entries globally (no role-based filtering)
    const ledgerEntries = await Ledger.find(ledgerQuery)
      .populate('agent', 'name email phone branch _id')
      .populate('agentId', 'name email phone branch _id')
      .populate('tripId', 'lrNumber route _id')
      .sort({ createdAt: -1 })
      .limit(50);

    // Transform trips
    const transformedTrips = trips.map(trip => ({
      ...trip.toObject(),
      id: trip._id,
      agentId: trip.agent?._id || trip.agentId?._id || trip.agentId,
      agent: trip.agent?.name || trip.agentId?.name || trip.agent,
      agentDetails: trip.agent || trip.agentId,
    }));

    // Transform ledger entries
    const transformedLedger = ledgerEntries.map(entry => ({
      ...entry.toObject(),
      id: entry._id,
      agentId: entry.agent?._id || entry.agentId?._id || entry.agentId,
      agent: entry.agent?.name || entry.agentId?.name || entry.agent,
    }));

    res.json({
      trips: transformedTrips,
      ledger: transformedLedger,
      searchTerm,
    });
  } catch (error) {
    console.error('Global LR search error:', error);
    res.status(500).json({ message: 'Server error during search' });
  }
};

module.exports = {
  globalLRSearch,
};

