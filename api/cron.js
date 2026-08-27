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
  console.log('Zoom token fetched:', data.access_token ? 'OK' : 'FAILED');
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

  console.log(`Total users fetched: ${users.length}`);
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
  } catch (e) {
    console.log('Redis get error:', e.message);
    return null;
  }
}

async function redisSet(key, value) {
  try {
    const res = await fetch(`${UPSTASH_URL}/set/${key}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    const data = await res.json();
    console.log('Redis set result:', data.result);
  } catch (e) {
    console.log('Redis set error:', e.message);
  }
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

  console.log('Slack alert sent for:', email);
}

module.exports = async function handler(req, res) {
  try {
    console.log('Cron started');
    const token = await getZoomToken();

    if (!token) {
      console.log('No token — check Zoom credentials');
      return res.status(500).send('Token error');
    }

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

      console.log(`User: ${email} | webinar: ${current.webinar} | large_meeting: ${current.large_meeting}`);

      // Get previous snapshot
      const key = `zoom_user_${user.id}`;
      const previous = await redisGet(key);

      if (previous) {
        console.log(`Previous for ${email}: webinar: ${previous.webinar} | large_meeting: ${previous.large_meeting}`);
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

        if (changes.length > 0) {
          console.log(`Changes detected for ${email}:`, changes);
          await sendSlackAlert(name, email, changes.join('\n'));
        } else {
          console.log(`No changes for ${email}`);
        }
      } else {
        console.log(`First run for ${email} — saving snapshot`);
      }

      // Save current snapshot
      await redisSet(key, JSON.stringify(current));
    }

    console.log('Cron completed');
    res.status(200).send('Cron completed');
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).send('Error');
  }
};
