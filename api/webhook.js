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

    // Build ONE clean message
    const settings = obj.settings?.feature || obj.settings || obj;

    const isAddingLargeMeeting = settings.large_meeting === true;
    const isRemovingLargeMeeting = settings.large_meeting === false;
    const isAddingWebinar = settings.webinar === true;
    const isRemovingWebinar = settings.webinar === false;
    const isAddingZoomPhone = settings.zoom_phone === true;
    const isRemovingZoomPhone = settings.zoom_phone === false;

    const largeMeetingCapacity = settings.large_meeting_capacity || '';
    const webinarCapacity = settings.webinar_capacity || '';

    let updateText = '';

    if (isAddingLargeMeeting) {
      updateText = `Large Meeting license (${largeMeetingCapacity} capacity) has been added`;
    } else if (isRemovingLargeMeeting) {
      updateText = `Large Meeting license has been removed. No license has been mapped`;
    } else if (isAddingWebinar) {
      updateText = `Webinar license (${webinarCapacity} capacity) has been added`;
    } else if (isRemovingWebinar) {
      updateText = `Webinar license has been removed. No license has been mapped`;
    } else if (isAddingZoomPhone) {
      updateText = `Zoom Phone license has been added`;
    } else if (isRemovingZoomPhone) {
      updateText = `Zoom Phone license has been removed. No license has been mapped`;
    } else {
      updateText = `No license has been mapped`;
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
