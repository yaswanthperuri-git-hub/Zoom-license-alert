const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function getZoomToken() {
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  const data = await res.json();
  return data.access_token;
}

async function getAllUsers(token) {
  let users = [];
  let nextPageToken = '';

  do {
    const url = `https://api.zoom.us/v2/users?page_size=300&status=active${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    users = users.concat(data.users || []);
    nextPageToken = data.next_page_token || '';
  } while (nextPageToken);

  return users;
}

async function getUserDetails(token, userId) {
  const res = await fetch(`https://api.zoom.us/v2/users/${userId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return res.json();
}

async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function redisSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${key}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(value)
  });
}

async function sendSlackAlert(name, email, updateText) {
  const timeStr = new Date().toLocaleString('en-IN', {
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

module.exports = async function handler(req, res) {
  try {
    const token = await getZoomToken();
    const users = await getAllUsers(token);

    for (const user of users) {
      const details = await getUserDetails(token, user.id);
      const email = details.email;
      const name = `${details.first_name} ${details.last_name}`;

      // Current license snapshot
      const current = {
        large_meeting: details.feature?.large_meeting || false,
        large_meeting_capacity: details.feature?.large_meeting_capacity || 0,
        webinar: details.feature?.webinar || false,
        webinar_capacity: details.feature?.webinar_capacity || 0,
        zoom_phone: details.feature?.zoom_phone || false
      };

      // Get previous snapshot
      const key = `zoom_user_${user.id}`;
      const previous = await redisGet(key);

      if (previous) {
        const changes = [];

        // Check large meeting
        if (previous.large_meeting !== current.large_meeting) {
          if (current.large_meeting) {
            changes.push(`Large Meeting license (${current.large_meeting_capacity} capacity) has been added`);
          } else {
            changes.push(`Large Meeting license has been removed. No license has been mapped`);
          }
        }

        // Check webinar
        if (previous.webinar !== current.webinar) {
          if (current.webinar) {
            changes.push(`Webinar license (${current.webinar_capacity} capacity) has been added`);
          } else {
            changes.push(`Webinar license has been removed. No license has been mapped`);
          }
        }

        // Check webinar capacity change
        if (previous.webinar && current.webinar && previous.webinar_capacity !== current.webinar_capacity) {
          changes.push(`Webinar capacity changed from ${previous.webinar_capacity} to ${current.webinar_capacity}`);
        }

        // Check zoom phone
        if (previous.zoom_phone !== current.zoom_phone) {
          if (current.zoom_phone) {
            changes.push(`Zoom Phone license has been added`);
          } else {
            changes.push(`Zoom Phone license has been removed. No license has been mapped`);
          }
        }

        // Send alert if anything changed
        if (changes.length > 0) {
          await sendSlackAlert(name, email, changes.join('\n'));
        }
      }

      // Save current snapshot
      await redisSet(key, JSON.stringify(current));
    }

    res.status(200).send('Cron completed');
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).send('Error');
  }
};
