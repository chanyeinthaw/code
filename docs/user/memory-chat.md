# Use memory chat

Memory chat keeps a continuing conversation while each reply starts a fresh provider session.
Original messages remain available when older context becomes summarized. Messages sent during a reply steer that reply.
Steering messages sent while memory is preparing join the same reply after compaction finishes.

1. Enable **Settings → Beta → Alternate layout**.
2. Open **Chat**. The first memory is created automatically on the connected primary environment.
3. Choose a provider and model in the composer, then send a message.

Open **Chat** to return to your last selected memory.
Click the memory name in the details card to switch memories or open **Manage memories**.
You can also switch memories and open management through **Cmd+K** on macOS or **Ctrl+K** elsewhere.
Manage memories in **Settings → Memory**. Filter by environment, or choose **All environments**.
Choose **New memory**, then enter a name and select its environment.
To move ownership, open a memory's **⋯** menu and choose **Move to another environment**.
Interrupted moves show **Resume transfer**, with **Cancel transfer** available before ownership is released.
Memory creation does not require support for threads without a project.
Each identity has its own conversation and workspace.
Memories stay separate from project pickers, project search, and ordinary thread lists.
Codex 0.160.0 or newer, Claude Code, Pi, and local OpenCode support memory replies.
Each Codex instance keeps its configured home, login, models, and composer options.
Older Codex instances are disabled for memory chat. If the version cannot be verified, memory turns stop before inference starts.
Other providers are unavailable for replies because their current integrations cannot enforce the memory tool policy. Your configured native MCP servers remain available.
Files attached to a message are available through `t3_attachment_read`. Images use the provider's normal image input.

## Coordinate work

Memory delegates work to subagents by default and can start ordinary threads for ongoing work.
Subagents use the memory conversation's workspace and receive its frozen memory view with tools to recall details and read attachments.
That view stays fixed while the parent conversation continues. Ordinary threads do not inherit memory.
For work in another project, memory starts an ordinary thread in that project.
It uses your configured providers, models, and options, and receives delegated results through T3 Code's existing notifications.
Ask explicitly when you want it to act directly using its available tools.
Memory can also show visualizations, inspect browser and device views when enabled, and track pull requests.

## Choose the compaction model

Set **Settings → Memory → Memory compaction model** on the owning environment.
Reset this setting to use its text generation model. The reply model remains independent.
Compaction runs in the background with instructions to call no tools.
Tools are disabled where the provider supports it, including native MCP servers where possible.
Compaction continues if tool isolation cannot be confirmed. Codex still requires version 0.160.0 or newer.
A new reply waits for pending summaries before freezing its memory view.
New compaction requests for that memory wait until its reply ends. Other memories compact independently.
**Memory compaction concurrency** defaults to eight requests per provider instance across all memories
in the owning environment. Choose 2, 4, 6, or 8 requests in the same settings section. Changes apply to
subsequent requests; requests already running finish normally.

## Move a memory to another environment

Connect both environments, finish or cancel pending turns, then open **Manage memories**, select a destination, and choose **Move**.
The move carries the conversation, original messages, summaries, workspace, and attachments.
The destination uses its own providers and compaction setting. Select an available provider there if the previous one is unavailable.

The source stops accepting memory turns before the destination takes ownership.
If the connection breaks, reconnect both environments and choose **Resume transfer**.
You can cancel a move until the source releases ownership.

Keep the owning environment online to continue its memories from another device.
Connecting from another device does not move ownership or inference to that device.
