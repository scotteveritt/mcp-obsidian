#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

// Maximum number of search results to return
const SEARCH_LIMIT = 200

// Command line argument parsing
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("Usage: mcp-obsidian <vault-directory>")
  process.exit(1)
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p).toLowerCase()
}

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1))
  }
  return filepath
}

// Store allowed directories in normalized form
const vaultDirectories = [normalizePath(path.resolve(expandHome(args[0])))]

// Validate that all directories exist and are accessible
await Promise.all(
  args.map(async (dir) => {
    try {
      const stats = await fs.stat(dir)
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`)
        process.exit(1)
      }
    } catch (error) {
      console.error(`Error accessing directory ${dir}:`, error)
      process.exit(1)
    }
  })
)

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  // Ignore hidden files/directories starting with "."
  const pathParts = requestedPath.split(path.sep)
  if (pathParts.some((part) => part.startsWith("."))) {
    throw new Error("Access denied - hidden files/directories not allowed")
  }

  const expandedPath = expandHome(requestedPath)
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath)

  const normalizedRequested = normalizePath(absolute)

  // Check if path is within allowed directories
  const isAllowed = vaultDirectories.some((dir) =>
    normalizedRequested.startsWith(dir)
  )
  if (!isAllowed) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${vaultDirectories.join(
        ", "
      )}`
    )
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute)
    const normalizedReal = normalizePath(realPath)
    const isRealPathAllowed = vaultDirectories.some((dir) =>
      normalizedReal.startsWith(dir)
    )
    if (!isRealPathAllowed) {
      throw new Error(
        "Access denied - symlink target outside allowed directories"
      )
    }
    return realPath
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute)
    try {
      const realParentPath = await fs.realpath(parentDir)
      const normalizedParent = normalizePath(realParentPath)
      const isParentAllowed = vaultDirectories.some((dir) =>
        normalizedParent.startsWith(dir)
      )
      if (!isParentAllowed) {
        throw new Error(
          "Access denied - parent directory outside allowed directories"
        )
      }
      return absolute
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`)
    }
  }
}

// Schema definitions
const ReadNotesArgsSchema = z.object({
  paths: z.array(z.string()),
})

const SearchNotesArgsSchema = z.object({
  query: z.string(),
})

const WriteNoteArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
})

const AppendNoteArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
})

const ExtractLinksArgsSchema = z.object({
  path: z.string(),
})

const FindBacklinksArgsSchema = z.object({
  path: z.string(),
})

const ExtractMetadataArgsSchema = z.object({
  path: z.string(),
})

const SearchByTagsArgsSchema = z.object({
  tags: z.array(z.string()),
  matchAll: z.boolean().optional().default(false),
})

const CreateLinkArgsSchema = z.object({
  fromPath: z.string(),
  toPath: z.string(),
  linkText: z.string().optional(),
})

const ToolInputSchema = ToolSchema.shape.inputSchema
type ToolInput = z.infer<typeof ToolInputSchema>

// Server setup
const server = new Server(
  {
    name: "mcp-obsidian",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

/**
 * Extract wiki links and markdown links from a note's content
 */
function extractLinks(content: string): { wikiLinks: string[], markdownLinks: string[] } {
  const wikiLinks: string[] = []
  const markdownLinks: string[] = []
  
  // Extract [[wiki links]]
  const wikiLinkRegex = /\[\[([^\]]+)\]\]/g
  let match
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    // Handle aliases: [[note|alias]]
    const link = match[1].split('|')[0].trim()
    if (!wikiLinks.includes(link)) {
      wikiLinks.push(link)
    }
  }
  
  // Extract [markdown](links)
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    const link = match[2].trim()
    // Only include internal links (ending with .md)
    if (link.endsWith('.md') && !link.startsWith('http')) {
      if (!markdownLinks.includes(link)) {
        markdownLinks.push(link)
      }
    }
  }
  
  return { wikiLinks, markdownLinks }
}

/**
 * Extract frontmatter and inline metadata from a note
 */
function extractMetadata(content: string): { frontmatter: Record<string, any>, inlineFields: Record<string, string>, tags: string[] } {
  const result = {
    frontmatter: {} as Record<string, any>,
    inlineFields: {} as Record<string, string>,
    tags: [] as string[]
  }
  
  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatterMatch) {
    try {
      // Simple YAML parsing (for basic key-value pairs)
      const yamlContent = frontmatterMatch[1]
      const lines = yamlContent.split('\n')
      for (const line of lines) {
        const colonIndex = line.indexOf(':')
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim()
          const value = line.substring(colonIndex + 1).trim()
          result.frontmatter[key] = value
        }
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }
  
  // Extract inline fields (Key:: Value)
  const inlineFieldRegex = /([^:\n]+)::([^\n]+)/g
  let match
  while ((match = inlineFieldRegex.exec(content)) !== null) {
    const key = match[1].trim()
    const value = match[2].trim()
    result.inlineFields[key] = value
  }
  
  // Extract tags (#tag)
  const tagRegex = /#[\w-]+/g
  while ((match = tagRegex.exec(content)) !== null) {
    const tag = match[0]
    if (!result.tags.includes(tag)) {
      result.tags.push(tag)
    }
  }
  
  // Extract tags from frontmatter
  if (result.frontmatter.tags) {
    const tagsValue = result.frontmatter.tags
    const frontmatterTags = (typeof tagsValue === 'string' ? tagsValue.split(',') : [])
      .map((t: string) => t.trim())
      .filter((t: string) => t)
      .map((t: string) => t.startsWith('#') ? t : `#${t}`)
    
    for (const tag of frontmatterTags) {
      if (!result.tags.includes(tag)) {
        result.tags.push(tag)
      }
    }
  }
  
  return result
}

/**
 * Search for notes in the allowed directories that match the query.
 * @param query - The query to search for.
 * @returns An array of relative paths to the notes (from root) that match the query.
 */
async function searchNotes(query: string): Promise<string[]> {
  const results: string[] = []

  async function search(basePath: string, currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      try {
        // Validate each path before processing
        await validatePath(fullPath)

        let matches = entry.name.toLowerCase().includes(query.toLowerCase())
        try {
          matches =
            matches ||
            new RegExp(query.replace(/[*]/g, ".*"), "i").test(entry.name)
        } catch {
          // Ignore invalid regex
        }

        if (entry.name.endsWith(".md") && matches) {
          // Turn into relative path
          results.push(fullPath.replace(basePath, ""))
        }

        if (entry.isDirectory()) {
          await search(basePath, fullPath)
        }
      } catch (error) {
        // Skip invalid paths during search
        continue
      }
    }
  }

  await Promise.all(vaultDirectories.map((dir) => search(dir, dir)))
  return results
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_notes",
        description:
          "Read the contents of multiple notes. Each note's content is returned with its " +
          "path as a reference. Failed reads for individual notes won't stop " +
          "the entire operation. Reading too many at once may result in an error.",
        inputSchema: zodToJsonSchema(ReadNotesArgsSchema) as ToolInput,
      },
      {
        name: "search_notes",
        description:
          "Searches for a note by its name. The search " +
          "is case-insensitive and matches partial names. " +
          "Queries can also be a valid regex. Returns paths of the notes " +
          "that match the query.",
        inputSchema: zodToJsonSchema(SearchNotesArgsSchema) as ToolInput,
      },
      {
        name: "write_note",
        description:
          "Write content to a note file. Creates the file if it doesn't exist, " +
          "or overwrites if it does. The path should be relative to the vault root " +
          "and end with .md extension. Parent directories will be created if needed.",
        inputSchema: zodToJsonSchema(WriteNoteArgsSchema) as ToolInput,
      },
      {
        name: "append_note",
        description:
          "Append content to an existing note file. Creates the file if it doesn't exist. " +
          "The path should be relative to the vault root and end with .md extension. " +
          "Content is added with a newline separator if the file has existing content.",
        inputSchema: zodToJsonSchema(AppendNoteArgsSchema) as ToolInput,
      },
      {
        name: "extract_links",
        description:
          "Extract all wiki links ([[note]]) and markdown links from a note. " +
          "Returns both types of links found in the note content. Useful for understanding " +
          "note connections and building a knowledge graph.",
        inputSchema: zodToJsonSchema(ExtractLinksArgsSchema) as ToolInput,
      },
      {
        name: "find_backlinks",
        description:
          "Find all notes that link to a specific note. Searches through all notes in the vault " +
          "to find wiki links and markdown links pointing to the specified note. Essential for " +
          "understanding how knowledge connects backwards.",
        inputSchema: zodToJsonSchema(FindBacklinksArgsSchema) as ToolInput,
      },
      {
        name: "extract_metadata",
        description:
          "Extract frontmatter, inline fields (key:: value), and tags from a note. " +
          "Returns structured metadata including YAML frontmatter, Dataview-style inline fields, " +
          "and all #tags found in the note.",
        inputSchema: zodToJsonSchema(ExtractMetadataArgsSchema) as ToolInput,
      },
      {
        name: "search_by_tags",
        description:
          "Search for notes containing specific tags. Can match all tags (AND) or any tag (OR). " +
          "Tags can be specified with or without the # prefix. Searches both inline tags and " +
          "frontmatter tags.",
        inputSchema: zodToJsonSchema(SearchByTagsArgsSchema) as ToolInput,
      },
      {
        name: "create_link",
        description:
          "Create or update a wiki link from one note to another. Adds [[target]] or [[target|linkText]] " +
          "at the end of the source note. Useful for programmatically building connections between thoughts.",
        inputSchema: zodToJsonSchema(CreateLinkArgsSchema) as ToolInput,
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params

    switch (name) {
      case "read_notes": {
        const parsed = ReadNotesArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_notes: ${parsed.error}`)
        }
        const results = await Promise.all(
          parsed.data.paths.map(async (filePath: string) => {
            try {
              const validPath = await validatePath(
                path.join(vaultDirectories[0], filePath)
              )
              const content = await fs.readFile(validPath, "utf-8")
              return `${filePath}:\n${content}\n`
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error)
              return `${filePath}: Error - ${errorMessage}`
            }
          })
        )
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        }
      }
      case "search_notes": {
        const parsed = SearchNotesArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_notes: ${parsed.error}`)
        }
        const results = await searchNotes(parsed.data.query)

        const limitedResults = results.slice(0, SEARCH_LIMIT)
        return {
          content: [
            {
              type: "text",
              text:
                (limitedResults.length > 0
                  ? limitedResults.join("\n")
                  : "No matches found") +
                (results.length > SEARCH_LIMIT
                  ? `\n\n... ${
                      results.length - SEARCH_LIMIT
                    } more results not shown.`
                  : ""),
            },
          ],
        }
      }
      case "write_note": {
        const parsed = WriteNoteArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_note: ${parsed.error}`)
        }
        
        // Ensure the path ends with .md
        if (!parsed.data.path.endsWith(".md")) {
          throw new Error("Note path must end with .md extension")
        }
        
        const fullPath = path.join(vaultDirectories[0], parsed.data.path)
        const validPath = await validatePath(fullPath)
        
        // Create parent directory if it doesn't exist
        const parentDir = path.dirname(validPath)
        await fs.mkdir(parentDir, { recursive: true })
        
        // Write the file
        await fs.writeFile(validPath, parsed.data.content, "utf-8")
        
        return {
          content: [{ type: "text", text: `Successfully wrote note to ${parsed.data.path}` }],
        }
      }
      case "append_note": {
        const parsed = AppendNoteArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for append_note: ${parsed.error}`)
        }
        
        // Ensure the path ends with .md
        if (!parsed.data.path.endsWith(".md")) {
          throw new Error("Note path must end with .md extension")
        }
        
        const fullPath = path.join(vaultDirectories[0], parsed.data.path)
        const validPath = await validatePath(fullPath)
        
        // Create parent directory if it doesn't exist
        const parentDir = path.dirname(validPath)
        await fs.mkdir(parentDir, { recursive: true })
        
        // Check if file exists and read existing content
        let existingContent = ""
        try {
          existingContent = await fs.readFile(validPath, "utf-8")
        } catch (error) {
          // File doesn't exist, which is fine for append
        }
        
        // Append content with proper separator
        const newContent = existingContent
          ? existingContent + "\n" + parsed.data.content
          : parsed.data.content
          
        await fs.writeFile(validPath, newContent, "utf-8")
        
        return {
          content: [{ type: "text", text: `Successfully appended to note at ${parsed.data.path}` }],
        }
      }
      case "extract_links": {
        const parsed = ExtractLinksArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for extract_links: ${parsed.error}`)
        }
        
        const fullPath = path.join(vaultDirectories[0], parsed.data.path)
        const validPath = await validatePath(fullPath)
        const content = await fs.readFile(validPath, "utf-8")
        
        const links = extractLinks(content)
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              wikiLinks: links.wikiLinks,
              markdownLinks: links.markdownLinks,
              totalLinks: links.wikiLinks.length + links.markdownLinks.length
            }, null, 2)
          }],
        }
      }
      case "find_backlinks": {
        const parsed = FindBacklinksArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for find_backlinks: ${parsed.error}`)
        }
        
        const targetPath = parsed.data.path
        const targetNote = targetPath.replace(/\.md$/, "")
        const backlinks: string[] = []
        
        // Search all notes for links to this note
        async function searchForBacklinks(basePath: string, currentPath: string) {
          const entries = await fs.readdir(currentPath, { withFileTypes: true })
          
          for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name)
            
            try {
              await validatePath(fullPath)
              
              if (entry.name.endsWith(".md")) {
                const content = await fs.readFile(fullPath, "utf-8")
                const links = extractLinks(content)
                
                // Check wiki links
                for (const link of links.wikiLinks) {
                  if (link === targetNote || link === targetPath) {
                    const relativePath = fullPath.replace(basePath, "")
                    if (!backlinks.includes(relativePath)) {
                      backlinks.push(relativePath)
                    }
                    break
                  }
                }
                
                // Check markdown links
                for (const link of links.markdownLinks) {
                  if (link === targetPath || link.endsWith(`/${targetPath}`)) {
                    const relativePath = fullPath.replace(basePath, "")
                    if (!backlinks.includes(relativePath)) {
                      backlinks.push(relativePath)
                    }
                    break
                  }
                }
              }
              
              if (entry.isDirectory()) {
                await searchForBacklinks(basePath, fullPath)
              }
            } catch (error) {
              // Skip invalid paths
              continue
            }
          }
        }
        
        await Promise.all(vaultDirectories.map((dir) => searchForBacklinks(dir, dir)))
        
        return {
          content: [{
            type: "text",
            text: backlinks.length > 0 
              ? `Found ${backlinks.length} backlinks:\n${backlinks.join("\n")}`
              : "No backlinks found"
          }],
        }
      }
      case "extract_metadata": {
        const parsed = ExtractMetadataArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for extract_metadata: ${parsed.error}`)
        }
        
        const fullPath = path.join(vaultDirectories[0], parsed.data.path)
        const validPath = await validatePath(fullPath)
        const content = await fs.readFile(validPath, "utf-8")
        
        const metadata = extractMetadata(content)
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              frontmatter: metadata.frontmatter,
              inlineFields: metadata.inlineFields,
              tags: metadata.tags
            }, null, 2)
          }],
        }
      }
      case "search_by_tags": {
        const parsed = SearchByTagsArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_by_tags: ${parsed.error}`)
        }
        
        const searchTags = parsed.data.tags.map(t => t.startsWith('#') ? t : `#${t}`)
        const matchAll = parsed.data.matchAll || false
        const results: string[] = []
        
        async function searchByTags(basePath: string, currentPath: string) {
          const entries = await fs.readdir(currentPath, { withFileTypes: true })
          
          for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name)
            
            try {
              await validatePath(fullPath)
              
              if (entry.name.endsWith(".md")) {
                const content = await fs.readFile(fullPath, "utf-8")
                const metadata = extractMetadata(content)
                
                const hasMatch = matchAll
                  ? searchTags.every(tag => metadata.tags.includes(tag))
                  : searchTags.some(tag => metadata.tags.includes(tag))
                
                if (hasMatch) {
                  results.push(fullPath.replace(basePath, ""))
                }
              }
              
              if (entry.isDirectory()) {
                await searchByTags(basePath, fullPath)
              }
            } catch (error) {
              continue
            }
          }
        }
        
        await Promise.all(vaultDirectories.map((dir) => searchByTags(dir, dir)))
        
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? `Found ${results.length} notes with tags ${searchTags.join(", ")}:\n${results.join("\n")}`
              : `No notes found with tags ${searchTags.join(", ")}`
          }],
        }
      }
      case "create_link": {
        const parsed = CreateLinkArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_link: ${parsed.error}`)
        }
        
        const fromPath = path.join(vaultDirectories[0], parsed.data.fromPath)
        const validFromPath = await validatePath(fromPath)
        
        // Read existing content
        let content = ""
        try {
          content = await fs.readFile(validFromPath, "utf-8")
        } catch {
          // File doesn't exist yet
        }
        
        // Create the link
        const targetNote = parsed.data.toPath.replace(/\.md$/, "")
        const linkText = parsed.data.linkText
          ? `[[${targetNote}|${parsed.data.linkText}]]`
          : `[[${targetNote}]]`
        
        // Append the link
        const newContent = content ? `${content}\n\n${linkText}` : linkText
        await fs.writeFile(validFromPath, newContent, "utf-8")
        
        return {
          content: [{
            type: "text",
            text: `Successfully created link from ${parsed.data.fromPath} to ${parsed.data.toPath}`
          }],
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    }
  }
})

// Start server
async function runServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("MCP Obsidian Server running on stdio")
  console.error("Allowed directories:", vaultDirectories)
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error)
  process.exit(1)
})
