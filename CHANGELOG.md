# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2024-10-14

### Added
- Interactive prompt feature: If no query is provided as an argument, the application now prompts the user to enter one
- LLM_STREAM_RESPONSE environment variable to toggle streaming functionality
- Streaming response functionality for real-time output
- Color-coded CLI output using chalk

### Changed
- Updated main function to handle cases where no initial prompt is provided
- Updated generateWithContext function to support both streaming and non-streaming modes
- Refactored main function to handle streaming and non-streaming responses
- Enhanced error handling for both streaming and non-streaming modes

---

## [1.0.0] - 2024-10-13

### Added
- Initial project setup
- Web search functionality using SearXNG
- Prompt rephrasing for improved search results
- Content extraction from search results
- Added an option to disable SSL validation for SearXNG
- AI-powered response generation using OpenAI API
- Error logging and detailed activity logging
- Timeout mechanism for script execution
- Content summarization to manage context length
- Response quality check and regeneration if needed
