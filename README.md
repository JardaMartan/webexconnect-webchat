# Webex Connect Chat Widget

A custom, lightweight web chat widget designed for Webex Connect (IMIconnect). This widget uses the Real-Time Messaging API (RTMS) to facilitate customer support conversations.

## Features

- **Real-Time Messaging**: Built on Webex RTMS via MQTT / WebSocket.
- **Rich Media Support**: Handles text, images, videos, audio, files, and location maps.
- **Interactive Elements**: Supports Form templates and Quick Replies (Postback).
- **History Management**: Automatically fetches and renders conversation history.
- **Customizable**: Configuration via HTML attributes.
- **Auto-Start**: Supports automated initial messages (visible or hidden).

## Prerequisites

- Node.js (v18+ recommended)
- NPM

## Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/JardaMartan/webexconnect-webchat.git
    cd webexconnect-webchat
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run locally:
    ```bash
    npm run dev
    ```

## Configuration

The widget is configured entirely via HTML attributes on the `<chat-widget>` custom element. You must replace the placeholder values with your specific Webex Connect service credentials.

### Required Attributes

| Attribute        | Description                                      | Source in Webex Connect |
| ---------------- | ------------------------------------------------ | ----------------------- |
| `app-id`         | Your App ID (e.g., `AI0208...`)                  | Assets -> Apps          |
| `client-key`     | The "Secret Key" header value                    | Assets -> Apps -> Config|
| `base-url`       | The RTMS API Endpoint                            | API Docs / Settings     |

> **Note on Base URL**: The RTMS URL differs from your standard Webex Connect login URL. It often includes a region suffix (e.g., `-usor`).
> *   **Standard URL**: `https://<tenant>.us.webexconnect.io`
> *   **RTMS URL (Use this)**: `https://<tenant>-usor.us.webexconnect.io/rtmsAPI/api/v3`

### Optional Attributes

| Attribute              | Description                                                                 | Default |
| ---------------------- | --------------------------------------------------------------------------- | ------- |
| `start-message`        | Text to auto-send when a new chat starts (e.g., "Hello").                   | `null`  |
| `start-message-hidden` | If `true`, the start message is sent but hidden from the UI (silent start). | `false` |

## Usage

### 1. Local Development
Open `index.html` and replace the placeholder values with your credentials:

```html
  <chat-widget 
    start-message="hello" 
    start-message-hidden="true" 
    app-id="YOUR_APP_ID" 
    client-key="YOUR_CLIENT_KEY"
    base-url="https://<tenant>-usor.us.webexconnect.io/rtmsAPI/api/v3">
  </chat-widget>
```

### 2. Integration / Production

To deploy this widget to your website:

1.  **Build the project**:
    ```bash
    npm run build
    ```
    This generates the production assets in the `dist/` folder.

2.  **Host the assets**: Upload the JS and CSS files from `dist/assets/` to your CDN or web server.

3.  **Embed in your HTML**:
    Add the script tag and the widget element to your page.

    ```html
    <!-- Import the Widget Logic -->
    <script type="module" src="https://your-cdn.com/assets/index.js"></script>
    <link rel="stylesheet" href="https://your-cdn.com/assets/index.css">

    <!-- Place the Widget -->
    <chat-widget 
        app-id="..." 
        client-key="..." 
        ...>
    </chat-widget>
    ```

### Security Note
**Never commit your real Service Secrets or Keys to public repositories.** 
- For local testing, use a local `index.html` that is git-ignored, or manually paste keys.
- For production, inject these values via your server-side template engine or CI/CD pipeline.

## Customization

The widget uses standard CSS variables and Shadow DOM. You can customize the appearance by modifying `src/index.css` or `src/components/ChatWidget.js`.

## License
MIT
