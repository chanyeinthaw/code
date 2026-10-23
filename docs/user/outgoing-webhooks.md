# Outgoing webhooks

Sora can post JSON to a URL you choose when a thread finishes, fails, needs approval, or asks for input. Open **Settings → Integrations → Outgoing webhooks**. Hark is one example destination; any endpoint that accepts a JSON POST works.

Webhooks belong to one environment. The environment selector at the top of Settings narrows the list. **New webhook** asks which connected environment owns it. **Copy to another environment** starts a new webhook there from the same settings. Ordinary endpoint URLs are copied; secret URLs and header values need fresh input. The two webhooks share nothing afterwards.

## Configure a webhook

- **Endpoint URL.** URLs are ordinary, readable configuration by default. Turn on **Secret URL** for a URL that contains a credential. Secret URLs stay hidden after saving; leave the endpoint empty when editing to keep it. Turning **Secret URL** off makes the stored URL readable again. Existing webhooks keep their classification until you change it.
- **Headers.** Add headers only if the destination needs them. Header values always stay secret. Leave a value empty when editing to keep it.
- **Send when.** Pick any of Completed, Failed, Approval needed, and Input needed. Subagent threads, stopped runs, and settled results do not send, matching mobile notifications.
- **Body template.** A JSON object or array. Use `{{thread.id}}`, `{{thread.title}}`, `{{thread.url}}`, `{{thread.soraUrl}}`, `{{thread.t3codeUrl}}`, `{{message.preview}}`, `{{event.type}}`, and `{{event.emoji}}` inside string values. Sora fills them in after parsing the JSON, so quotes and line breaks in a title cannot break the body. The default is `{"title":"{{thread.title}}","body":"{{message.preview}}","url":"{{thread.url}}"}`.
- **Event emoji.** Use `"title":"{{event.emoji}} {{thread.title}}"` for a title with ✅ on completion, ❌ on failure, ✋ for approval, or 💬 for input. Test deliveries use 🧪.
- **Preview length.** `message.preview` is the thread's last reply cut to this many characters, 500 by default.
- **App links.** `thread.soraUrl` and `thread.t3codeUrl` open the installed app at the thread using `sora://threads/<environment id>/<thread id>` and `t3code://threads/<environment id>/<thread id>`. They work without a Client URL.
- **Client URL.** `thread.url` is `<client URL>/<environment id>/<thread id>`. Sora never guesses an address, so the variable is empty until you set the URL you open Sora at.

**Send test** posts sample content once, without retries. **Deliveries** lists recent results as a status and category only. Response bodies and error text are not kept.

## Delivery

Delivery is at least once. A queued alert keeps the body template, client URL and preview it was created with, so every retry sends identical content even if you edit the webhook meanwhile; endpoint and header changes apply to the next attempt. A network error, a 429, or a 5xx response is retried up to five times with growing delays, and every attempt carries the same `Idempotency-Key` header so the destination can drop duplicates. Other 4xx responses are not retried. Turning a webhook off cancels what it had queued, and deleting it removes its history and secrets. A slow or failing destination never delays a thread's next turn.

## Agents

Agents can read and edit webhooks through the `s3_outgoing_webhooks_list`, `s3_outgoing_webhooks_upsert` and `s3_outgoing_webhooks_delete` tools, which need a full-access thread or client.

- **Endpoint.** Give the agent the URL, or let it ask you for it privately, which keeps the URL out of the conversation. Many destinations put their credential in the URL itself; that needs nothing else. Tell the agent to mark credential-bearing URLs secret. Ordinary URLs remain readable; privately entered URLs default to secret.
- **Headers.** Only needed when the destination wants separate authentication. The agent asks you for each value privately, so a credential never reaches the model. Leave headers out for a webhook that needs none.
- **Editing.** Leaving out the endpoint, its secret classification, or the headers keeps what is stored.

Agents cannot send a webhook themselves, and these tools only reach the environment they run in.
