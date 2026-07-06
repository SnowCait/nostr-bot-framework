import { ADMIN_CLIENT } from './client-bundle.generated.js';

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 60rem; padding: 1rem; line-height: 1.5; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: 1rem; }
section { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 0 1rem 1rem; margin: 1rem 0; }
textarea { width: 100%; min-height: 6rem; font-family: ui-monospace, monospace; }
input[type=text], input[type=password] { width: 100%; }
button { margin: 0.25rem 0.25rem 0.25rem 0; }
.status { font-size: 0.85rem; opacity: 0.8; white-space: pre-wrap; word-break: break-all; }
.error { color: #c00; }
.ok { color: #080; }
code { word-break: break-all; }
`;

function Shell() {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Bot Admin</title>
				<style dangerouslySetInnerHTML={{ __html: STYLE }} />
			</head>
			<body>
				<h1>Bot Admin</h1>
				<p id="login-area">
					<button id="login">Sign in with NIP-07 extension</button>
					<span id="whoami" class="status"></span>
				</p>
				<div id="bots"></div>
				<script dangerouslySetInnerHTML={{ __html: ADMIN_CLIENT }} />
			</body>
		</html>
	);
}

export const ADMIN_PAGE = '<!doctype html>' + (<Shell />).toString();
