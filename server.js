/**
 * TrustWork — Backend API Routes
 * =================================
 * Express.js server that connects your frontend,
 * Supabase database, and Paystack payments.
 *
 * Install: npm install express cors helmet express-rate-limit dotenv
 * Run:     node server.js  (or: npx nodemon server.js for dev)
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

// Import your modules
const paystack   = require('./trustwork-paystack-multicurrency');
const { supabaseAdmin } = require('./lib/supabase');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── SECURITY MIDDLEWARE ────────────────────────────────────────────────────

app.use(helmet());           // sets secure HTTP headers
app.use(cors({
  origin: process.env.APP_BASE_URL || 'http://localhost:3000',
  credentials: true,
}));

// Rate limiting — prevents abuse, protects at scale
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // 100 requests per IP per 15 min
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api/', limiter);

// Stricter limit on payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 20,
  message: { error: 'Too many payment requests. Please wait before trying again.' },
});

app.use(express.json());

// ─── AUTH HELPER ────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role').eq('id', req.user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  version: '1.0.0',
}));

// ═══════════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/payments/initialize
 * Hirer clicks "Fund Escrow & Post Job"
 * Returns a Paystack payment URL to redirect them to
 */
app.post('/api/payments/initialize', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const { jobId, currency = 'NGN' } = req.body;

    // Fetch job details from Supabase
    const { data: job, error } = await supabaseAdmin
      .from('jobs').select('*').eq('id', jobId).single();

    if (error || !job) return res.status(404).json({ error: 'Job not found' });
    if (job.hirer_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
    if (job.escrow_funded) return res.status(400).json({ error: 'Job already funded' });

    // Get hirer's email
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('email').eq('id', req.user.id).single();

    const result = await paystack.initializeEscrow({
      hirerEmail: profile.email,
      jobId,
      jobTitle:   job.title,
      amount:     job.budget,
      currency,
    });

    res.json({ success: true, paymentUrl: result.paymentUrl, fees: result.fees });

  } catch (err) {
    console.error('Payment init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payments/verify/:reference
 * Called after Paystack redirects hirer back to your site
 */
app.get('/api/payments/verify/:reference', requireAuth, async (req, res) => {
  try {
    const result = await paystack.verifyEscrowPayment(req.params.reference);

    if (result.success) {
      // Activate the job in Supabase
      await supabaseAdmin.from('jobs').update({
        status:           'active',
        escrow_funded:    true,
        escrow_reference: req.params.reference,
        escrow_funded_at: new Date().toISOString(),
      }).eq('id', result.jobId);
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/payments/release
 * Hirer approves work — triggers payout to worker
 */
app.post('/api/payments/release', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const { jobId, submissionId } = req.body;

    const { data: job } = await supabaseAdmin
      .from('jobs').select('*, assigned_worker:profiles!jobs_assigned_worker_id_fkey(*)').eq('id', jobId).single();

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.hirer_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
    if (job.status !== 'submitted') return res.status(400).json({ error: 'No submission to approve' });

    // Get worker bank account
    const { data: bankAccount } = await supabaseAdmin
      .from('bank_accounts').select('*')
      .eq('user_id', job.assigned_worker_id).eq('is_primary', true).single();

    if (!bankAccount) return res.status(400).json({ error: 'Worker has no bank account linked' });

    // Release payment via Paystack
    const payout = await paystack.releaseEscrowToWorker({
      jobId,
      workerAccountNumber: bankAccount.account_number,
      workerBankCode:      bankAccount.bank_code,
      workerName:          bankAccount.account_name,
      jobAmount:           job.budget,
      jobCurrency:         job.currency,
      workerCurrency:      bankAccount.currency,
    });

    // Mark submission approved and job complete in Supabase
    await supabaseAdmin.from('submissions')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', submissionId);

    await supabaseAdmin.from('jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', jobId);

    await supabaseAdmin.from('escrow_transactions')
      .update({ status: 'released', released_at: new Date().toISOString(),
                paystack_transfer_code: payout.transferCode })
      .eq('job_id', jobId);

    // Notify worker
    await supabaseAdmin.from('notifications').insert({
      user_id: job.assigned_worker_id,
      type:    'payment_released',
      title:   '💸 Payment sent!',
      message: `Your payment of ${payout.workerPayout} for "${job.title}" is on its way.`,
      data:    { job_id: jobId },
    });

    res.json({ success: true, payout });

  } catch (err) {
    console.error('Release error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/payments/refund
 * Admin-only: refund hirer after dispute ruled in their favour
 */
app.post('/api/payments/refund', requireAdmin, async (req, res) => {
  try {
    const { jobId, reason } = req.body;

    const { data: escrow } = await supabaseAdmin
      .from('escrow_transactions').select('*').eq('job_id', jobId).single();

    const result = await paystack.refundHirer({
      transactionReference: escrow.paystack_reference,
      amount:   escrow.gross_amount,
      currency: escrow.currency,
      reason,
    });

    await supabaseAdmin.from('jobs').update({ status: 'refunded' }).eq('id', jobId);
    await supabaseAdmin.from('escrow_transactions')
      .update({ status: 'refunded', refunded_at: new Date().toISOString() })
      .eq('job_id', jobId);

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payments/fees?amount=150000&currency=NGN
 * Used by your UI to show the fee breakdown preview before payment
 */
app.get('/api/payments/fees', async (req, res) => {
  try {
    const { amount, currency = 'NGN' } = req.query;
    const fees = await paystack.calculateFees(parseFloat(amount), currency);
    res.json(fees);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PAYSTACK WEBHOOK
// Must be PUBLIC (no auth) — Paystack calls this directly
// ═══════════════════════════════════════════════════════════════════

const crypto = require('crypto');

app.post('/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Unauthorized');
  }

  const { event, data } = JSON.parse(req.body);

  try {
    switch (event) {
      case 'charge.success':
        await supabaseAdmin.from('jobs').update({
          status: 'active', escrow_funded: true,
          escrow_reference: data.reference,
          escrow_funded_at: new Date().toISOString(),
        }).eq('id', data.metadata?.job_id);

        await supabaseAdmin.from('escrow_transactions').update({
          status: 'funded', funded_at: new Date().toISOString(),
        }).eq('paystack_reference', data.reference);
        break;

      case 'transfer.success':
        await supabaseAdmin.from('escrow_transactions').update({
          status: 'released', released_at: new Date().toISOString(),
        }).eq('paystack_transfer_code', data.transfer_code);
        break;

      case 'transfer.failed':
        console.error('Transfer failed:', data.transfer_code);
        // Alert your support team here (email, Slack, etc.)
        break;
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }

  res.sendStatus(200); // Always 200 to Paystack
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const earnings = await paystack.getPlatformEarnings();
    res.json(earnings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    await supabaseAdmin.from('platform_settings')
      .update({ value, updated_by: req.user.id, updated_at: new Date().toISOString() })
      .eq('key', key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   TrustWork API running on :${PORT}   ║
  ║   Environment: ${process.env.NODE_ENV || 'development'}             ║
  ╚══════════════════════════════════════╝
  `);
});

module.exports = app;
