# 🌐 Web-Augmented Generation

This Node.js application performs web-augmented generation using Ollama and web search results from SearXNG.

## Features

- Rephrases user queries for optimal web searching
- Searches the web using SearXNG
- Fetches and summarizes content from search results
- Generates responses using Ollama, incorporating web-sourced information
- Logs detailed information about the process

## Prerequisites

- Node.js (version 16 or higher)
- npm (Node Package Manager)
- Ollama server running locally or remotely
- Access to a SearXNG instance

## Setup

1. Clone the repository:
   ```
   git clone https://github.com/jparkerweb/web-augmented-generation.git
   cd web-augmented-generation
   ```

2. Install dependencies:
   ```
   npm ci
   ```

3. Copy the `.env.example` file to `.env`:
   ```
   cp .env.example .env
   ```

4. Edit the `.env` file and update the values as needed:
   ```
   OLLAMA_BASE_URL=http://localhost:11434
   SEARXNG_URL=https://searxng.acme.org
   SEARXNG_URL_EXTRA_PARAMETER="key=your_auth_key_here"
   NUM_URLS=5
   FETCH_TIMEOUT_MS=5000
   OLLAMA_MODEL=llama3.2
   DISABLE_SSL_VALIDATION=false
   SEARXNG_FORMAT=json
   ```

   - `OLLAMA_BASE_URL`: URL of your Ollama server
   - `OLLAMA_MODEL`: The name of the Ollama model to use (default: llama3.2)
   - `NUM_URLS`: Number of search results to process (default: 5)
   - `SEARXNG_URL`: URL of the SearXNG instance to use for web searches
   - `SEARXNG_URL_EXTRA_PARAMETER`: Additional URL parameters for SearXNG requests (e.g., authentication key)
   - `SEARXNG_FORMAT`: Format for SearXNG results, either 'html' or 'json' (default: json)
   - `FETCH_TIMEOUT_MS`: Timeout for fetching web content in milliseconds (default: 5000)
   - `DISABLE_SSL_VALIDATION`: Set to 'true' to disable SSL certificate validation (use with caution)

## Usage

Run the application with a query:

```
node main.js "Your question or prompt here"
```

The application will:
1. Rephrase the query for better search results
2. Search the web using SearXNG
3. Fetch and summarize content from the search results
4. Generate a response using Ollama, incorporating the web-sourced information
5. Log the process details to `log.txt`

The generated response will be displayed in the console and appended to the log file.

## Error Handling

If an error occurs during execution, it will be logged to `error_log.txt` in the project directory.

## Files

- `main.js`: Main application logic
- `.env`: Configuration file (create this from `.env.example`)
- `log.txt`: Detailed log of each run
- `error_log.txt`: Error log (created if errors occur)
- `completion_flag.txt`: Created when the process completes successfully

## Note

This application uses web scraping and AI-generated content. Ensure you comply with the terms of service of the websites you're accessing and the AI models you're using.

## Running SearXNG Locally (Docker)

If you want to run SearXNG locally using Docker, follow these steps:

1. Pull the latest SearXNG Docker image:
   ```
   docker pull searxng/searxng
   ```

2. Create a directory for SearXNG configuration:
   ```
   mkdir searxng-config
   ```

3. Create a settings.yml file in the searxng-config directory:
   ```
   touch searxng-config/settings.yml
   ```

4. Edit the settings.yml file to ensure that 'json' is included in the 'formats' list:
   ```
   nano searxng-config/settings.yml
   ```
   Add or modify the following lines:
   ```yaml
   search:
     formats:
       - html
       - json
   ```

5. Run the SearXNG Docker container:
   ```
   docker run -d \
     -v $(pwd)/searxng-config:/etc/searxng \
     -p 8787:8080 \
     -e BASE_URL=http://localhost:8787/ \
     -e INSTANCE_NAME=my-searxng \
     searxng/searxng
   ```

6. Access your local SearXNG instance at `http://localhost:8787`

7. Update your .env file to use the local SearXNG instance:
   ```
   SEARXNG_URL=http://localhost:8787
   ```

Now you have a local SearXNG instance running on port 8787 with JSON output enabled, which you can use with this application.

## Config Options

- `SEARXNG_URL_EXTRA_PARAMETER`: This field allows you to add extra parameters to the SearXNG search URL. It can be used for various purposes:
  - Authentication: If your SearXNG instance requires an API key or token, you can add it here. For example: `key=your_auth_key_here`
  - Custom search parameters: You can add any SearXNG-specific parameters to customize your search. For example: `language=en&time_range=year`
  - Multiple parameters: You can combine multiple parameters using `&`. For example: `key=your_auth_key_here&language=en`

- `SEARXNG_FORMAT`: This field determines the format of the SearXNG search results. It can be set to either 'html' or 'json':
  - 'html': The application will parse HTML responses from SearXNG
  - 'json': The application will expect and parse JSON responses from SearXNG (default)

  Example usage in .env file:
  ```
  SEARXNG_URL_EXTRA_PARAMETER="key=abcdef123456&language=en"
  SEARXNG_FORMAT=json
  ```

  This would append `&key=abcdef123456&language=en` to the SearXNG search URL, and the application will expect and parse JSON responses from SearXNG.

- `DISABLE_SSL_VALIDATION`: Set to 'true' to disable SSL certificate validation (default: false, use with caution)

---

## Example Nginx Configuration with an auth key serving SearXNG on port 8787

```nginx
    server {
        listen       80;
        listen       443 ssl;
        server_name  searxng.acme.org;
        ssl_certificate         C:/some-path/fullchain.pem;
        ssl_certificate_key     C:/some-path/privkey.pem;

        # Define a variable to store the API key
        set $api_key "eXamPle__Key!!!";

        # Use a secure cookie to store the key
        set $key_cookie "searxng_key";

        # Add resolver directive
        resolver 127.0.0.1;

        # Debug logging
        error_log  logs/error.log debug;

        # Check if the key is valid
        set $key_valid 0;
        if ($arg_key = $api_key) {
            set $key_valid 1;
        }
        if ($cookie_searxng_key = $api_key) {
            set $key_valid 1;
        }

        # Allow access to static files without key
        location /static/ {
            proxy_pass http://127.0.0.1:8787;
            proxy_buffering off;
        }

        # Redirect all requests without a valid key to a default error page or login page
        location = / {
            if ($key_valid = 0) {
                return 403;
            }
            proxy_pass http://127.0.0.1:8787;
            proxy_buffering off;
        }

        location / {
            # Debug headers (always add these for debugging)
            add_header X-Debug-Key-Valid $key_valid always;
            add_header X-Debug-Arg-Key $arg_key always;
            add_header X-Debug-Cookie-Key $cookie_searxng_key always;

            # If the key is not valid, return 403
            if ($key_valid = 0) {
                return 403;
            }

            # Set the cookie if the key is provided in the URL
            if ($arg_key = $api_key) {
                add_header Set-Cookie "${key_cookie}=$arg_key; HttpOnly; Secure; SameSite=Strict; Path=/;" always;
            }

            # Proxy headers
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Preserve the key parameter during redirects
            proxy_redirect ~^(https?://[^/]+)(.*)$ $1$2$is_args$args;

            # Pass the request to the upstream server
            proxy_pass http://127.0.0.1:8787;
            proxy_buffering off;
        }
    }
```

## Ask Scripts

This project includes convenient scripts to run the application from the command line. These scripts are located in the `ask-scripts` directory:

- `ask`: Universal script for Unix-like systems and Windows
- `ask.sh`: Bash script for Unix-like systems
- `ask.bat`: Batch script for Windows Command Prompt
- `ask.ps1`: PowerShell script for Windows PowerShell

### Usage

To use these scripts globally, you need to add the `ask-scripts` directory to your system's PATH. Here are instructions for different operating systems:

#### Windows

1. Open the Start menu and search for "Environment Variables"
2. Click on "Edit the system environment variables"
3. Click the "Environment Variables" button
4. Under "System variables", find and select the "Path" variable, then click "Edit"
5. Click "New" and add the full path to your `ask-scripts` directory
6. Click "OK" to close all dialogs

#### macOS and Linux

1. Open your shell configuration file (e.g., `~/.bashrc`, `~/.zshrc`, or `~/.bash_profile`)
2. Add the following line, replacing `/path/to/ask-scripts` with the actual path:
   ```
   export PATH="$PATH:/path/to/ask-scripts"
   ```
3. Save the file and restart your terminal or run `source ~/.bashrc` (or the appropriate file you edited)

### Running the Scripts

Once the `ask-scripts` directory is in your PATH, you can run the application from anywhere by simply typing:

```
ask
```

The script will then prompt you to enter your question or prompt.

This command will automatically use the appropriate script for your system:

- On Unix-like systems (Linux, macOS), it will use the bash script.
- On Windows, it will detect your environment and use the appropriate script (PowerShell or Command Prompt).

You don't need to provide the question or prompt as a command-line argument. The script will interactively ask for your input.

These scripts provide a convenient way to interact with the application without having to navigate to the project directory or manually run `node main.js` each time.

![ask-scripts](./ask-scripts/ask.gif)
