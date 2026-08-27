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
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
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
    const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
    const data = await res.json();
    console.log(`Redis set [${key}]: ${data.result}`);
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
      return res.status(500).send('Token error');
    }

    const users = await getAllUsers(token);

    for (const user of users) {
      const details = await getUserDetails(token, user.id);
      const email = details.email;
      const name = `${details.first_name} ${details.last_name}`;

      // Log raw feature to debug
      console.log(`Feature for ${email}:`, JSON.stringify(details.feature || {}));

      const current = {
        large_meeting: details.feature?.large_meeting === true,
        large_meeting_capacity: details.feature?.large_meeting_capacity || 0,
        webinar: details.feature?.webinar === true,
        webinar_capacity: details.feature?.webinar_capacity || 0,
        zoom_phone: details.feature?.zoom_phone === true
      };

      const key = `zoom_user_${user.id}`;
      const previous = await redisGet(key);

      if (previous) {
        const changes = [];

        if (previous.large_meeting === true && current.large_meeting === false) {
          changes.push(`Large Meeting license has been removed. No license has been mapped`);
        } else if (previous.large_meeting === false && current.large_meeting === true) {
          changes.push(`Large Meeting license (${current.large_meeting_capacity} capacity) has been added`);
        }

        if (previous.webinar === true && current.webinar === false) {
          changes.push(`Webinar license has been removed. No license has been mapped`);
        } else if (previous.webinar === false && current.webinar === true) {
          changes.push(`Webinar license (${current.webinar_capacity} capacity) has been added`);
        }

        if (previous.webinar === true && current.webinar === true && previous.webinar_capacity !== current.webinar_capacity) {
          changes.push(`Webinar capacity changed from ${previous.webinar_capacity} to ${current.webinar_capacity}`);
        }

        if (previous.zoom_phone === true && current.zoom_phone === false) {
          changes.push(`Zoom Phone license has been removed. No license has been mapped`);
        } else if (previous.zoom_phone === false && current.zoom_phone === true) {
          changes.push(`Zoom Phone license has been added`);
        }

        if (changes.length > 0) {
          console.log(`Changes for ${email}:`, changes);
          await sendSlackAlert(name, email, changes.join('\n'));
        } else {
          console.log(`No changes for ${email}`);
        }
      } else {
        console.log(`First run for ${email} — saving snapshot`);
      }

      await redisSet(key, current);
    }

    console.log('Cron completed');
    res.status(200).send('Cron completed');
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).send('Error');
  }
};
