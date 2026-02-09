
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'release_stage', 'index.html');
let content = fs.readFileSync(indexPath, 'utf8');

// Replacements
content = content.replace(/app-id="[^"]*"/g, 'app-id="YOUR_APP_ID"');
content = content.replace(/client-key="[^"]*"/g, 'client-key="YOUR_CLIENT_KEY"');
content = content.replace(/site-url="[^"]*"/g, 'site-url="YOUR_SITE_URL"');
content = content.replace(/widget-id="[^"]*"/g, 'widget-id="YOUR_WIDGET_ID"');
content = content.replace(/custom-profile-params="[^"]*"/g, 'custom-profile-params="YOUR_CUSTOM_PARAMS"');

// Sanitize base-url if it looks specific?
// content = content.replace(/base-url="\/rtmsAPI\/api\/v3"/g, 'base-url="YOUR_API_BASE_URL"');
// Leaving base-url as it might be a standard proxy path or relative path necessary for the widget to work if behind a proxy. 
// However, the example usually has site-url which derives base-url. 
// Let's stick to the main credentials.

fs.writeFileSync(indexPath, content);
console.log('Sanitized release_stage/index.html');
