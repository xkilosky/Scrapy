export interface ToolImage {
  /** Base64-encoded image bytes, as MCP image content requires. */
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  text: string;
  images: ToolImage[];
}
