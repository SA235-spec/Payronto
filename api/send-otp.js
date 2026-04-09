const axios = require('axios');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { phone } = req.body;

  try {
    await axios.post('https://api.ng.termii.com/api/sms/otp/send', {
      api_key: process.env.TERMII_API_KEY,
      message_type: 'NUMERIC',
      to: phone,
      from: process.env.TERMII_SENDER_ID,
      channel: 'generic',
      pin_attempts: 3,
      pin_time_to_live: 5,
      pin_length: 6,
      pin_placeholder: '< 1234 >',
      message_text: 'Your TrustWork verification code is < 1234 >',
      pin_type: 'NUMERIC'
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};
