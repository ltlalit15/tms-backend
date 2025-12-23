const express = require('express');
const router = express.Router();
const { globalLRSearch } = require('../controllers/searchController');

// Global LR search route - accessible to all users
router.get('/lr/:lrNumber', globalLRSearch);

module.exports = router;

