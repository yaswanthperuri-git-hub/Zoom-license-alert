const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
  const ZOOM_SECRET = process.env.ZOOM_SECRET_TOKEN;
  const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', resolve);
  });

  const parsedBody = JSON.parse(body);
  const { event, payload, event_ts } = parsedBody;

  // Zoom URL verification handshake
  if (event === 'endpoint.url_validation') {
    const hash = crypto
      .createHmac('sha256', ZOOM_SECRET)
      .update(payload.plainToken)
      .digest('hex');
    return res.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  const userEvents = [
    'user.updated',
    'user.settings_updated',
    'user.activated',
    'user.deactivated',
    'user.created'
  ];

  if (userEvents.includes(event)) {
    const obj = payload.object;
    const userId = obj.id;

    // Get Zoom access token
    const tokenRes = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user details
    const userRes = await fetch(`https://api.zoom.us/v2/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const userData = await userRes.json();

    const name = `${userData.first_name} ${userData.last_name}`;
    const email = userData.email;

    // Build message
    const settings = obj.settings?.feature || obj.settings || obj;
    const messages = [];

    const isRemovingLargeMeeting = settings.large_meeting === false;
    const isRemovingWebinar = settings.webinar === false;
    const largeMeetingCapacity = settings.large_meeting_capacity || settings.meeting_capacity || '';

    for (const [key, value] of Object.entries(settings)) {
      if (key === 'large_meeting') {
        messages.push(value
          ? `Large Meeting license (${largeMeetingCapacity} capacity) has been added`
          : `Large Meeting license (${largeMeetingCapacity} capacity) has been removed`
        );
      } else if (key === 'large_meeting_capacity') {
        if (!isRemovingLargeMeeting) {
          messages.push(`Large Meeting capacity updated to ${value}`);
        }
      } else if (key === 'meeting_capacity') {
        if (isRemovingLargeMeeting) {
          // skip
        } else if (value === 300 && messages.length === 0) {
          messages.push(`No license has been mapped`);
        } else {
          messages.push(`Meeting capacity updated to ${value}`);
        }
      } else if (key === 'webinar') {
        const webinarCapacity = settings.webinar_capacity || '';
        messages.push(value
          ? `Webinar license (${webinarCapacity} capacity) has been added`
          : `Webinar license (${webinarCapacity} capacity) has been removed`
        );
      } else if (key === 'webinar_capacity') {
        if (!isRemovingWebinar) {
          messages.push(`Webinar capacity updated to ${value}`);
        }
      } else if (key === 'zoom_phone') {
        messages.push(value
          ? `Zoom Phone license has been added`
          : `Zoom Phone license has been removed`
        );
      } else {
        messages.push(`${key} updated to ${value}`);
      }
    }

    // Time in IST
    const date = new Date(event_ts);
    const timeStr = date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    const updateText = messages.length > 0
      ? messages.join('\n')
      : 'No license has been mapped';

    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `<!here> *Zoom License Changed*\n*Account Name:* ${name}\n*Account Email:* ${email}\n*Update:* ${updateText}\n*Time:* ${timeStr}`
            }
          }
        ]
      })
    });
  }

  return res.status(200).send('OK');
};
