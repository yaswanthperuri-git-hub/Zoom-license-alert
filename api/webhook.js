const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const ZOOM_SECRET = process.env.ZOOM_SECRET_TOKEN;
  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', resolve);
  });

  const rawBody = body;
  const parsedBody = JSON.parse(rawBody);
  const { event, payload, event_ts } = parsedBody;

  // Zoom URL verification handshake
  if (event === 'endpoint.url_validation') {
    const hash = crypto
      .createHmac('sha256', ZOOM_SECRET)
      .update(payload.plainToken)
      .digest('hex');
    return res.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  // Verify signature from Zoom
  const message = `v0:${event_ts}:${rawBody}`;
  const signature = `v0=${crypto
    .createHmac('sha256', ZOOM_SECRET)
    .update(message)
    .digest('hex')}`;

  if (req.headers['x-zm-signature'] !== signature) {
    return res.status(401).send('Unauthorized');
  }

  // Catch all user events
  const userEvents = [
    'user.updated',
    'user.settings_updated',
    'user.activated',
    'user.deactivated',
    'user.created'
  ];

  if (userEvents.includes(event)) {
    const { email, first_name, last_name } = payload.object;

    console.log('ZOOM EVENT:', event);
    console.log('ZOOM PAYLOAD:', JSON.stringify(parsedBody, null, 2));

    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🔄 Zoom User Changed' }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*User:*\n${first_name} ${last_name}` },
              { type: 'mrkdwn', text: `*Email:*\n${email}` },
              { type: 'mrkdwn', text: `*Event Type:*\n${event}` },
              { type: 'mrkdwn', text: `*Data:*\n\`\`\`${JSON.stringify(payload.object, null, 2).slice(0, 200)}\`\`\`` }
            ]
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Triggered at <!date^${Math.floor(event_ts / 1000)}^{date_short_pretty} at {time}|just now>`
              }
            ]
          }
        ]
      })
    });
  }

  return res.status(200).send('OK');
};
