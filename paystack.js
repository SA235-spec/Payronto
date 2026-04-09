/**
 * TrustWork — Multi-Currency Paystack Integration (NGN + USD)
 * =============================================================
 * Supports Nigerian Naira (NGN) and US Dollar (USD) escrow payments.
 *
 * How currency works:
 *   - NGN: standard Paystack Nigerian flow, amounts in kobo (×100)
 *   - USD: Paystack international flow, amounts in cents (×100)
 *   - Worker always chooses their payout currency at onboarding
 *   - If hirer pays USD but worker wants NGN, auto-convert at live rate
 *
 * Setup checklist:
 *   ✅ Paystack account with multi-currency enabled (Settings → Business)
 *   ✅ Two subaccounts: one NGN, one USD (Settings → Subaccounts)
 *   ✅ Exchangerate API key for live USD↔NGN conversion (free at exchangerate-api.com)
 *   ✅ Fill in your .env file (template at the bottom of this file)
 *   ✅ npm install axios express dotenv crypto
 */

require('dotenv').config();
const axios   = require('axios');
const crypto  = require('crypto');
const express = require('express');
const app     = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────

const CONFIG = {
  paystackSecret:        process.env.PAYSTACK_SECRET_KEY,
  platformSubaccount: {
    NGN: process.env.PLATFORM_SUBACCOUNT_NGN,  // e.g. ACCT_xxxxxxxxx (naira account)
    USD: process.env.PLATFORM_SUBACCOUNT_USD,  // e.g. ACCT_yyyyyyyyy (dollar account)
  },
  feePercent:            Number(process.env.PLATFORM_FEE_PERCENT) || 10,
  exchangeRateApiKey:    process.env.EXCHANGE_RATE_API_KEY,
  appBaseUrl:            process.env.APP_BASE_URL || 'https://yourapp.com',
};

const SUPPORTED_CURRENCIES = ['NGN', 'USD'];

const paystackHeaders = {
  Authorization: `Bearer ${CONFIG.paystackSecret}`,
  'Content-Type': 'application/json',
};

// ─── CURRENCY UTILS ────────────────────────────────────────────────────────

/**
 * Convert major currency unit to smallest unit Paystack expects.
 * NGN → kobo (×100), USD → cents (×100). Same multiplier, kept explicit for clarity.
 */
function toSmallestUnit(amount, currency) {
  const multipliers = { NGN: 100, USD: 100 };
  return Math.round(amount * (multipliers[currency] || 100));
}

function fromSmallestUnit(amount, currency) {
  const divisors = { NGN: 100, USD: 100 };
  return amount / (divisors[currency] || 100);
}

function currencySymbol(currency) {
  return currency === 'USD' ? '$' : '₦';
}

function validateCurrency(currency) {
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency: ${currency}. Use NGN or USD.`);
  }
}

// ─── LIVE EXCHANGE RATE ────────────────────────────────────────────────────

let rateCache = { rate: null, fetchedAt: null };

async function getLiveRate(from = 'USD', to = 'NGN') {
  const cacheAgeMs = rateCache.fetchedAt ? Date.now() - rateCache.fetchedAt : Infinity;
  const CACHE_TTL  = 30 * 60 * 1000; // refresh every 30 minutes

  if (rateCache.rate && cacheAgeMs < CACHE_TTL) {
    return rateCache.rate;
  }

  try {
    const res = await axios.get(
      `https://v6.exchangerate-api.com/v6/${CONFIG.exchangeRateApiKey}/pair/${from}/${to}`
    );
    rateCache = { rate: res.data.conversion_rate, fetchedAt: Date.now() };
    console.log(`📈 Live rate: 1 ${from} = ${rateCache.rate} ${to}`);
    return rateCache.rate;
  } catch (err) {
    console.warn('Exchange rate fetch failed, using fallback rate');
    return 1580; // fallback — update periodically
  }
}

/**
 * Convert an amount between currencies using live rate.
 * e.g. convertAmount(100, 'USD', 'NGN') → 158000
 */
async function convertAmount(amount, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return amount;
  const rate = await getLiveRate(fromCurrency, toCurrency);
  return Math.round(amount * rate);
}

// ─── FEE CALCULATOR ────────────────────────────────────────────────────────

/**
 * Returns a full breakdown of fees for a given job amount.
 * Use this to show the preview in your UI before the hirer pays.
 */
async function calculateFees(amount, currency) {
  validateCurrency(currency);

  const platformFee  = Math.round(amount * (CONFIG.feePercent / 100));
  const workerPayout = amount - platformFee;

  // Show equivalent in the other currency for transparency
  const otherCurrency = currency === 'NGN' ? 'USD' : 'NGN';
  const rate          = await getLiveRate(currency, otherCurrency);
  const equivalent    = Math.round(amount * rate);

  return {
    currency,
    jobAmount:    amount,
    platformFee,
    workerPayout,
    feePercent:   CONFIG.feePercent,
    equivalent: {
      currency:   otherCurrency,
      amount:     equivalent,
      rate,
    },
    display: {
      jobAmount:    `${currencySymbol(currency)}${amount.toLocaleString()}`,
      platformFee:  `${currencySymbol(currency)}${platformFee.toLocaleString()}`,
      workerPayout: `${currencySymbol(currency)}${workerPayout.toLocaleString()}`,
      equivalent:   `≈ ${currencySymbol(otherCurrency)}${equivalent.toLocaleString()}`,
    },
  };
}

// ─── STEP 1: INITIALIZE ESCROW PAYMENT ─────────────────────────────────────

/**
 * Creates a Paystack payment link for the hirer.
 * currency: 'NGN' or 'USD'
 */
async function initializeEscrow({
  hirerEmail,
  jobId,
  jobTitle,
  amount,
  currency = 'NGN',
}) {
  validateCurrency(currency);

  const fees           = await calculateFees(amount, currency);
  const amountSmallest = toSmallestUnit(amount, currency);
  const feeSmallest    = toSmallestUnit(fees.platformFee, currency);

  const reference = `TW-${currency}-${jobId}-${Date.now()}`;

  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email:    hirerEmail,
        amount:   amountSmallest,
        currency,                          // ← NGN or USD
        reference,
        metadata: {
          job_id:        jobId,
          job_title:     jobTitle,
          currency,
          payment_type:  'escrow',
          platform_fee:  fees.platformFee,
          worker_payout: fees.workerPayout,
          exchange_rate: fees.equivalent.rate,
        },
        // Platform fee split — auto-deducted on payment
        split: {
          type:         'flat',
          bearer_type:  'subaccount',
          subaccounts: [
            {
              subaccount: CONFIG.platformSubaccount[currency],
              share:      feeSmallest,
            },
          ],
        },
        callback_url: `${CONFIG.appBaseUrl}/payment/callback?job_id=${jobId}&currency=${currency}`,
      },
      { headers: paystackHeaders }
    );

    const { authorization_url } = response.data.data;

    await saveEscrowRecord({
      jobId,
      reference,
      currency,
      amountSmallest,
      platformFeeSmallest: feeSmallest,
      workerPayoutSmallest: toSmallestUnit(fees.workerPayout, currency),
      status: 'pending',
    });

    console.log(`🔒 Escrow initialized: ${fees.display.jobAmount} (${currency}) for Job #${jobId}`);
    return { paymentUrl: authorization_url, reference, fees };

  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    throw new Error('Could not initialize payment. Please try again.');
  }
}

// ─── STEP 2: VERIFY PAYMENT ─────────────────────────────────────────────────

async function verifyEscrowPayment(reference) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: paystackHeaders }
    );

    const { status, amount, currency, metadata } = response.data.data;

    if (status !== 'success') {
      throw new Error(`Payment not successful. Status: ${status}`);
    }

    const amountMajor = fromSmallestUnit(amount, currency);
    await updateEscrowStatus(reference, 'funded');

    console.log(`✅ Escrow funded: ${currencySymbol(currency)}${amountMajor} for Job #${metadata.job_id}`);
    return {
      success:   true,
      jobId:     metadata.job_id,
      currency,
      amountPaid: amountMajor,
    };

  } catch (err) {
    console.error('Verify error:', err.response?.data || err.message);
    throw new Error('Payment verification failed.');
  }
}

// ─── STEP 3: RELEASE PAYMENT TO WORKER ─────────────────────────────────────

/**
 * Sends worker their payout after hirer approves.
 * Handles cross-currency: if hirer paid USD but worker wants NGN, converts automatically.
 *
 * jobCurrency:    the currency the job was paid in ('NGN' or 'USD')
 * workerCurrency: the currency the worker wants to receive ('NGN' or 'USD')
 */
async function releaseEscrowToWorker({
  jobId,
  workerAccountNumber,
  workerBankCode,
  workerName,
  jobAmount,
  jobCurrency      = 'NGN',
  workerCurrency   = 'NGN',
}) {
  validateCurrency(jobCurrency);
  validateCurrency(workerCurrency);

  // Calculate how much the worker should receive in their preferred currency
  const workerShareInJobCurrency = Math.round(jobAmount * ((100 - CONFIG.feePercent) / 100));
  const workerShareInTheirCurrency = await convertAmount(
    workerShareInJobCurrency,
    jobCurrency,
    workerCurrency
  );

  const payoutSmallest = toSmallestUnit(workerShareInTheirCurrency, workerCurrency);

  try {
    // Create transfer recipient
    const recipientRes = await axios.post(
      'https://api.paystack.co/transferrecipient',
      {
        type:           'nuban',
        name:            workerName,
        account_number:  workerAccountNumber,
        bank_code:       workerBankCode,
        currency:        workerCurrency,
      },
      { headers: paystackHeaders }
    );

    const recipientCode = recipientRes.data.data.recipient_code;

    // Initiate transfer
    const transferRes = await axios.post(
      'https://api.paystack.co/transfer',
      {
        source:    'balance',
        amount:     payoutSmallest,
        recipient:  recipientCode,
        reason:    `TrustWork payout — Job #${jobId}`,
        reference: `TW-PAYOUT-${jobId}-${Date.now()}`,
        currency:   workerCurrency,
      },
      { headers: paystackHeaders }
    );

    const transfer = transferRes.data.data;
    await updateEscrowStatus(jobId, 'released');

    const sym = currencySymbol(workerCurrency);
    console.log(`💸 Payout of ${sym}${workerShareInTheirCurrency.toLocaleString()} sent to ${workerName} for Job #${jobId}`);

    return {
      success:      true,
      transferCode:  transfer.transfer_code,
      workerPayout: `${sym}${workerShareInTheirCurrency.toLocaleString()}`,
      currency:      workerCurrency,
    };

  } catch (err) {
    console.error('Transfer error:', err.response?.data || err.message);
    throw new Error('Payout failed. Contact support.');
  }
}

// ─── STEP 4: REFUND HIRER ──────────────────────────────────────────────────

async function refundHirer({ transactionReference, amount, currency = 'NGN', reason }) {
  validateCurrency(currency);

  try {
    const response = await axios.post(
      'https://api.paystack.co/refund',
      {
        transaction:    transactionReference,
        amount:          toSmallestUnit(amount, currency),
        merchant_note:   reason || 'TrustWork dispute resolution — refund to hirer',
        currency,
      },
      { headers: paystackHeaders }
    );

    await updateEscrowStatus(transactionReference, 'refunded');
    const sym = currencySymbol(currency);
    console.log(`↩️ Refund of ${sym}${amount.toLocaleString()} issued`);
    return { success: true, refundData: response.data.data };

  } catch (err) {
    console.error('Refund error:', err.response?.data || err.message);
    throw new Error('Refund failed. Contact Paystack support.');
  }
}

// ─── WEBHOOK ────────────────────────────────────────────────────────────────

app.post('/paystack/webhook', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', CONFIG.paystackSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Unauthorized');
  }

  const { event, data } = req.body;
  const currency = data.currency || 'NGN';

  switch (event) {
    case 'charge.success':
      console.log(`✅ ${currency} payment confirmed: ${data.reference}`);
      await activateJob(data.metadata?.job_id);
      break;

    case 'transfer.success':
      console.log(`✅ ${currency} transfer done: ${data.transfer_code}`);
      await markJobComplete(data.reference);
      break;

    case 'transfer.failed':
      console.error(`❌ ${currency} transfer failed: ${data.transfer_code}`);
      await flagPayoutFailure(data.reference);
      break;

    case 'refund.processed':
      console.log(`↩️ Refund processed: ${data.transaction_reference}`);
      break;

    default:
      console.log(`Unhandled event: ${event}`);
  }

  res.sendStatus(200);
});

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function getNigerianBanks() {
  const res = await axios.get(
    'https://api.paystack.co/bank?country=nigeria&currency=NGN',
    { headers: paystackHeaders }
  );
  return res.data.data.map(b => ({ name: b.name, code: b.code }));
}

async function getInternationalBanks(country = 'ghana') {
  // For USD payouts, Paystack currently supports GH, KE, ZA, US
  const res = await axios.get(
    `https://api.paystack.co/bank?country=${country}&currency=USD`,
    { headers: paystackHeaders }
  );
  return res.data.data.map(b => ({ name: b.name, code: b.code }));
}

async function verifyBankAccount(accountNumber, bankCode) {
  const res = await axios.get(
    `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
    { headers: paystackHeaders }
  );
  return res.data.data;
}

async function getPlatformEarnings() {
  const [ngnRes, usdRes] = await Promise.all([
    axios.get('https://api.paystack.co/transaction?status=success&currency=NGN&perPage=100', { headers: paystackHeaders }),
    axios.get('https://api.paystack.co/transaction?status=success&currency=USD&perPage=100', { headers: paystackHeaders }),
  ]);

  const ngnVolume = ngnRes.data.data.reduce((s, t) => s + t.amount, 0) / 100;
  const usdVolume = usdRes.data.data.reduce((s, t) => s + t.amount, 0) / 100;
  const rate      = await getLiveRate('USD', 'NGN');

  const totalNgnEquivalent = ngnVolume + (usdVolume * rate);
  const platformRevenue    = Math.round(totalNgnEquivalent * (CONFIG.feePercent / 100));

  return {
    NGN: { volume: `₦${ngnVolume.toLocaleString()}`, transactions: ngnRes.data.data.length },
    USD: { volume: `$${usdVolume.toLocaleString()}`, transactions: usdRes.data.data.length },
    combined: {
      totalVolumeNGN:  `₦${Math.round(totalNgnEquivalent).toLocaleString()}`,
      platformRevenue: `₦${platformRevenue.toLocaleString()}`,
      feePercent:       CONFIG.feePercent,
      liveRate:        `1 USD = ₦${rate}`,
    },
  };
}

// ─── STUB DB FUNCTIONS ──────────────────────────────────────────────────────

async function saveEscrowRecord(data)       { console.log('[DB] Save escrow:', data); }
async function updateEscrowStatus(ref, s)   { console.log(`[DB] Escrow ${ref} → ${s}`); }
async function activateJob(jobId)            { console.log(`[DB] Job ${jobId} active`); }
async function markJobComplete(ref)          { console.log(`[DB] Job ${ref} complete`); }
async function flagPayoutFailure(ref)        { console.log(`[ALERT] Payout failed: ${ref}`); }

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  initializeEscrow,
  verifyEscrowPayment,
  releaseEscrowToWorker,
  refundHirer,
  calculateFees,
  getLiveRate,
  convertAmount,
  getNigerianBanks,
  getInternationalBanks,
  verifyBankAccount,
  getPlatformEarnings,
  SUPPORTED_CURRENCIES,
};

/*
═══════════════════════════════════════════════════════
  .env FILE TEMPLATE — copy this, fill in your values
═══════════════════════════════════════════════════════

PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PLATFORM_SUBACCOUNT_NGN=ACCT_xxxxxxxxxxxxxxx
PLATFORM_SUBACCOUNT_USD=ACCT_yyyyyyyyyyyyyyy
PLATFORM_FEE_PERCENT=10
EXCHANGE_RATE_API_KEY=your_key_from_exchangerate-api.com
APP_BASE_URL=https://yourapp.com

═══════════════════════════════════════════════════════
  USAGE EXAMPLES
═══════════════════════════════════════════════════════

// 1. Get fee preview before hirer pays (for UI display)
const fees = await calculateFees(500, 'USD');
// returns:
// { jobAmount: 500, platformFee: 50, workerPayout: 450,
//   display: { jobAmount: '$500', platformFee: '$50', ... },
//   equivalent: { currency: 'NGN', amount: 790000, rate: 1580 } }

// 2. Hirer pays in USD
const { paymentUrl } = await initializeEscrow({
  hirerEmail: 'client@company.com',
  jobId: 'job_042',
  jobTitle: 'Flutter App Development',
  amount: 500,
  currency: 'USD',
});
res.redirect(paymentUrl);

// 3. Hirer pays in NGN
const { paymentUrl } = await initializeEscrow({
  hirerEmail: 'hirer@ng.com',
  jobId: 'job_043',
  jobTitle: 'Logo Design',
  amount: 150000,
  currency: 'NGN',
});

// 4. Release payout — hirer paid USD, worker wants NGN (auto-converts)
await releaseEscrowToWorker({
  jobId: 'job_042',
  workerAccountNumber: '0123456789',
  workerBankCode: '058',
  workerName: 'Adeola Okonkwo',
  jobAmount: 500,
  jobCurrency: 'USD',
  workerCurrency: 'NGN',   // ← worker receives naira equivalent
});

// 5. Admin dashboard earnings (both currencies combined)
const earnings = await getPlatformEarnings();
// returns NGN volume, USD volume, combined NGN equivalent, your platform revenue
*/
