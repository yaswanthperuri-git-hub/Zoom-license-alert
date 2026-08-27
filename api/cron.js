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
  const [userRes, addonsRes] = await Promise.all([
    fetch(`https://api.zoom.us/v2/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }),
    fetch(`https://api.zoom.us/v2/users/${userId}/addons`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
  ]);
  const user = await userRes.json();
  const addons = await addonsRes.json();
  user.addons_data = addons?.addons || [];
  return user;
}

async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
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
    if (!token) return res.status(500).send('Token error');

    const users = await getAllUsers(token);

    for (const user of users) {
      const details = await getUserDetails(token, user.id);
      const email = details.email;
      const name = `${details.first_name} ${details.last_name}`;
      const addons = details.addons_data || [];

      // Extract webinar info from addons
      const webinarAddon = addons.find(a =>
        a.name?.toLowerCase().includes('webinar') ||
        a.label?.toLowerCase().includes('webinar')
      );
      const largeMeetingAddon = addons.find(a =>
        a.name?.toLowerCase().includes('large') ||
        a.label?.toLowerCase().includes('large')
      );

      const current = {
        webinar: !!webinarAddon,
        webinar_name: webinarAddon?.name || webinarAddon?.label || '',
        large_meeting: !!largeMeetingAddon,
        large_meeting_name: largeMeetingAddon?.name || largeMeetingAddon?.label || '',
        addons_snapshot: JSON.stringify(addons.map(a => a.name || a.label || a.id).sort())
      };

      console.log(`${email}: webinar=${current.webinar} large=${current.large_meeting} addons=${current.addons_snapshot}`);

      const key = `zoom_user_${user.id}`;
      const previous = await redisGet(key);

      if (previous) {
        // Only compare addons_snapshot — ignore everything else
        if (previous.addons_snapshot === current.addons_snapshot) {
          console.log(`No changes for ${email}`);
        } else {
          console.log(`Changes detected for ${email}`);
          const changes = [];

          // Webinar check
          if (!previous.webinar && current.webinar) {
            changes.push(`Webinar license (${current.webinar_name}) has been added`);
          } else if (previous.webinar && !current.webinar) {
            changes.push(`Webinar license has been removed. No license has been mapped`);
          }

          // Large meeting check
          if (!previous.large_meeting && current.large_meeting) {
            changes.push(`Large Meeting license (${current.large_meeting_name}) has been added`);
          } else if (previous.large_meeting && !current.large_meeting) {
            changes.push(`Large Meeting license has been removed. No license has been mapped`);
          }

          // Fallback if specific type not detected
          if (changes.length === 0) {
            const prev = JSON.parse(previous.addons_snapshot);
            const curr = JSON.parse(current.addons_snapshot);
            const added = curr.filter(a => !prev.includes(a));
            const removed = prev.filter(a => !curr.includes(a));
            if (added.length > 0) changes.push(`License added: ${added.join(', ')}`);
            if (removed.length > 0) changes.push(`License removed: ${removed.join(', ')}`);
          }

          if (changes.length > 0) {
            await sendSlackAlert(name, email, changes.join('\n'));
          }
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
