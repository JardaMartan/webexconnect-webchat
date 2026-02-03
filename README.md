# Webex Connect Chat Widget

A custom web component for embedding Webex App (IMI) chat functionality.

## Configuration

The widget is configured via HTML attributes on the `<chat-widget>` tag.

### Critical Parameters

| Attribute | Description | Required | Source |
|-----------|-------------|----------|--------|
| `app-id` | Your Webex App ID | Yes | Webex Connect |
| `client-key`        | `YOUR_CLIENT_KEY`    | **Required**. The secret key for authentication. |
| `site-url`             | `YOUR_SITE_URL`      | **Required**. Your Webex Connect Site URL (e.g. `https://ccbootcamsandbox...webexconnect.io`). The derived API and MQTT URLs are used automatically. |
| `website-domain`       | `YOUR_DOMAIN`        | **Required**. The "Website Domain" configured in your Web Chat Asset (e.g. `kp.cz`, `example.com`). |
| `widget-id` OR `data-bind` | The Widget ID (UUID) | **Yes** (for uploads) | **Webex Control Hub** (See below) |

### Obtaining the Widget ID (`data-bind`)

To enable file uploads, you must provide the `widget-id` (also known as `data-bind`). 

1.  Go to **Webex Control Hub**.
2.  Navigate to **Web Chat Assets**.
3.  In the "Installation" section, find the **Embed Code**.
4.  Look for the `data-bind` attribute in the snippet: `data-bind="GUID"`.
5.  Use this GUID as the `widget-id` or `data-bind` attribute on this widget.

For more details, refer to the [Webex Documentation: Set up Web Chat](https://help.webex.com/article/fgab23).

### Optional Parameters

| Attribute | Description | Default |
|-----------|-------------|---------|
| `start-message` | A message to send automatically when the chat starts. | None |
| `start-message-hidden` | If `true`, the start message is hidden from the user interface. | `false` |
| `custom-profile-params`| `YOUR_CUSTOM_PARAMS` | Custom profile parameters string for user context. |

## Example Usage

```html
<chat-widget
  app-id="AI00000000"
  client-key="your-client-key"
  site-url="https://ccbootcampsandbox.us.webexconnect.io"
  website-domain="example.com"
  widget-id="00000000-0000-0000-0000-000000000000"
  start-message-hidden="true"
></chat-widget>
<script type="module" src="./src/main.js"></script>
```

## Deployment

1.  **Build**: Run `npm run build` to generate the `dist/` folder.
2.  **Host**: Upload the contents of `dist/` to your web server (e.g., `https://kp.cz/chat/`).
3.  **Embed**:
    *   Include the JS and CSS files from the build in your website's main HTML.
    *   Add the `<chat-widget>` tag with your configuration.
4.  **CORS Requirement**: 
    *   Ensure your `website-domain` (e.g., `kp.cz`) matches the domain where you are hosting this widget.
    *   Webex Connect uses this domain to whitelist your requests (CORS).
## Webex Calling Integration

This widget supports in-browser voice calls using the Webex Calling SDK.

### Quick Reply Payload for "Start Call" Button

To trigger a call from a flow (e.g., Webex Connect), send a Quick Reply with a custom payload. The widget detects this payload to render a special "Start Call" card or button.

**Required JSON Format:**

```json
{
  "type": "webexcall",
  "destination": "+1234567890",
  "accessToken": "YOUR_WEBEX_CALLING_ACCESS_TOKEN"
}
```

*   **type**: Must be `"webexcall"`. (Legacy fallback: `description` = `"make a call using webex calling"`)
*   **destination**: The phone number or SIP URI to dial.
*   **accessToken**: A valid JWT access token for the Webex Calling user/device. This token is required to authenticate the call.

### Features
*   **Audio Settings**: Floating panel to select Microphone and Speaker devices.
*   **Call Controls**: Mute, Hangup, and Timer controls integrated into the chat footer.
*   **Persistence**: Active calls remain connected even if the chat widget is toggled (minimized).
