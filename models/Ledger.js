const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    default: null,
  },
  lrNumber: {
    type: String,
    default: null,
  },
  date: {
    type: Date,
    required: true,
    default: Date.now,
  },
  description: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: [
      'Trip Created',
      'Top-up',
      'Virtual Top-up',
      'Virtual Expense',
      'On-Trip Payment',
      'Agent Transfer',
      'Settlement',
      'Trip Closed',
      'Beta/Batta Credit',
    ],
  },
  amount: {
    type: Number,
    required: true,
    default: 0,
  },
  advance: {
    type: Number,
    default: 0,
  },
  balance: {
    type: Number,
    default: 0,
  },
  agent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  bank: {
    type: String,
    default: 'HDFC Bank',
  },
  direction: {
    type: String,
    required: true,
    enum: ['Credit', 'Debit'],
  },
}, {
  timestamps: true,
});

// Indexes for better query performance
ledgerSchema.index({ agent: 1 });
ledgerSchema.index({ tripId: 1 });
ledgerSchema.index({ date: -1 });
ledgerSchema.index({ createdAt: -1 });
ledgerSchema.index({ lrNumber: 1 });

module.exports = mongoose.model('Ledger', ledgerSchema);

