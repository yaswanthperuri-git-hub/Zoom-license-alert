const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const ZOOM_SECRET = process.env.ZOOM_SECRET_TOKEN;
  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

  const { event, payload, event_ts } = req.body;

  // Step 1: Zoom URL verification handshake (one-time when you click Validate)
  if (event === 'endpoint.url_validation') {
    const hash = crypto
      .createHmac('sha256', ZOOM_SECRET)
      .update(payload.plainToken)
      .digest('hex');
    return res.json({
      plainToken: payload.plainToken,
      encryptedToken: hash
    });
  }

  // Step 2: Verify the request is genuinely from Zoom
  const message = `v0:${event_ts}:${JSON.stringify(req.body)}`;
  const signature = `v0=${crypto
    .createHmac('sha256', ZOOM_SECRET)
    .update(message)
    .digest('hex')}`;

  if (req.headers['x-zm-signature'] !== signature) {
    return res.status(401).send('Unauthorized');
  }

  // Step 3: If license changed → send Slack notification immediately
  if (event === 'user.license_updated') {
    const { email, first_name, last_name, old_license, new_license } = payload.object;

    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '🔄 Zoom License Changed'
            }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*User:*\n${first_name} ${last_name}` },
              { type: 'mrkdwn', text: `*Email:*\n${email}` },
              { type: 'mrkdwn', text: `*From:*\n${old_license}` },
              { type: 'mrkdwn', text: `*To:*\n${new_license}` }
            ]
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Changed at <!date^${Math.floor(event_ts / 1000)}^{date_short_pretty} at {time}|just now>`
              }
            ]
          }
        ]
      })
    });
  }

  return res.status(200).send('OK');
};
