# Obsidian Model Context Protocol (Write-Enabled)

This is an enhanced version of the original [mcp-obsidian](https://github.com/henrykmao/mcp-obsidian) that adds **write and append capabilities** to allow Claude Desktop (or any MCP client) to read, search, write, and modify any directory containing Markdown notes (such as an Obsidian vault).

## New Features
- ✅ **write_note**: Create or overwrite notes
- ✅ **append_note**: Append content to existing notes
- ✅ All original read/search functionality preserved
- ✅ Automatic parent directory creation
- ✅ Same security model as original

## Credits
Based on the original [mcp-obsidian](https://github.com/henrykmao/mcp-obsidian) by Henry Mao.

## Installation

Make sure Claude Desktop and `npm` is installed.

### Installing via NPX (Recommended)

To install and run the enhanced version with write capabilities:

```bash
npx mcp-obsidian-tools /path/to/your/vault
```

For Claude Desktop, add to your MCP settings:

```json
{
  "mcpServers": {
    "obsidian-tools": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian-tools", "/path/to/your/vault"]
    }
  }
}
```

Then, restart Claude Desktop and you should see the following MCP tools listed:

![image](./images/mcp-tools.png)

### Usage with VS Code

For manual installation, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open User Settings (JSON)`.

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace. This will allow you to share the configuration with others.

> Note that the `mcp` key is not needed in the `.vscode/mcp.json` file.

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "vaultPath",
        "description": "Path to Obsidian vault"
      }
    ],
    "servers": {
      "obsidian-tools": {
        "command": "npx",
        "args": ["-y", "mcp-obsidian-tools", "${input:vaultPath}"]
      }
    }
  }
}
```

## Available Tools

This enhanced version provides 4 tools:

1. **read_notes** - Read contents of multiple notes (original functionality)
2. **search_notes** - Search for notes by name/pattern (original functionality)  
3. **write_note** - Create or overwrite a note with content
4. **append_note** - Append content to an existing note

### Write/Append Tool Usage

Both new tools require:
- `path`: Relative path from vault root (must end in `.md`)
- `content`: Markdown content to write/append

Examples:
```javascript
// Create a new note
write_note({
  path: "daily/2024-01-15.md",
  content: "# Daily Note\n\nToday's tasks:\n- Review code"
})

// Append to existing note
append_note({
  path: "daily/2024-01-15.md", 
  content: "\n\n## Evening Reflection\nCompleted code review successfully."
})
```
