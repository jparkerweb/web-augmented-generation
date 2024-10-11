import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import ollama from 'ollama';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import ora from 'ora';
import { setTimeout } from 'timers/promises';
import https from 'https';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: `${__dirname}/.env` });

if (process.env.OLLAMA_BASE_URL) {
  ollama.baseUrl = process.env.OLLAMA_BASE_URL;
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const SEARXNG_URL = process.env.SEARXNG_URL;
const NUM_URLS = parseInt(process.env.NUM_URLS) || 5;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS) || 5000;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const DISABLE_SSL_VALIDATION = process.env.DISABLE_SSL_VALIDATION === 'true';
const SEARXNG_FORMAT = process.env.SEARXNG_FORMAT || 'html';
const SEARXNG_URL_EXTRA_PARAMETER = process.env.SEARXNG_URL_EXTRA_PARAMETER || '';

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

if (!SEARXNG_URL) {
  console.error("SEARXNG_URL is not set. Please check your .env file.");
  process.exit(1);
}

async function fallbackSearch(query) {
  // Implement a fallback search method here
  // This could be a different search API or a simpler web scraping approach
  console.warn("Using fallback search method");
  // Return an array of URLs or an empty array if no results
}

async function searchWeb(query) {
  const searchUrl = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}${SEARXNG_FORMAT === 'json' ? '&format=json' : ''}${SEARXNG_URL_EXTRA_PARAMETER ? '&' + SEARXNG_URL_EXTRA_PARAMETER : ''}`;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      console.log(`Attempt ${attempt + 1}: Status ${response.status}`);

      if (response.status === 429) { // Too Many Requests
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Rate limited. Retrying in ${backoffTime}ms...`);
        await setTimeout(backoffTime);
        continue;
      }

      // Log headers for debugging
      console.log("Response headers:", Object.fromEntries(response.headers.entries()));

      const contentType = response.headers.get("content-type");

      let links = [];
      if (SEARXNG_FORMAT === 'json' && contentType && contentType.includes("application/json")) {
        const data = await response.json();
        const results = data.results || [];
        links = results.map(result => result.url);
      } else {
        const html = await response.text();
        links = extractLinksFromHTML(html);
      }

      if (links.length === 0) {
        console.warn(" ⇢ Warning: No search results returned. There may be an issue communicating with SearXNG.");
      }

      return links.slice(0, NUM_URLS);
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed:`, error);
      if (attempt === MAX_RETRIES - 1) {
        console.warn("SearXNG search failed, using fallback method");
        return fallbackSearch(query);
      }
      const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(`Error occurred. Retrying in ${backoffTime}ms...`);
      await setTimeout(backoffTime);
    }
  }
}

function extractLinksFromHTML(html) {
  const $ = cheerio.load(html);
  const links = [];
  $('article.result').each((index, element) => {
    const urlWrapper = $(element).find('a.url_wrapper');
    if (urlWrapper.length) {
      const href = urlWrapper.attr('href');
      if (href && !href.startsWith('/')) {
        links.push(href);
      }
    }
  });
  return links.slice(0, NUM_URLS);
}

async function fetchWebContent(url) {
  try {
    const timeoutPromise = setTimeout(FETCH_TIMEOUT_MS, 'Timeout');
    const fetchPromise = (async () => {
      const agent = DISABLE_SSL_VALIDATION ? new https.Agent({ rejectUnauthorized: false }) : undefined;
      const response = await fetch(url, { agent });
      const html = await response.text();
      const virtualConsole = new VirtualConsole();
      virtualConsole.on("error", () => { /* Ignore errors */ });
      const dom = new JSDOM(html, { 
        url,
        runScripts: "outside-only",
        resources: "usable",
        virtualConsole
      });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      return article ? article.textContent : "";
    })();

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    
    if (result === 'Timeout') {
      console.warn(`Skipping ${url} due to timeout (${FETCH_TIMEOUT_MS}ms)`);
      return "";
    }
    
    // Remove extra line breaks and trim lines with only spaces or tabs
    return result
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (error) {
    console.error(`Error fetching content from ${url}:`, error);
    return "";
  }
}

async function generateWithContext(prompt, context, options = {}) {
  const defaultOptions = {
    model: OLLAMA_MODEL,
    prompt: `You are a helpful assistant with access to the following information:

${context}

This information is current and factual. Your task is to use this information to answer the following question:

${prompt}

Provide a detailed and informative answer based primarily on the given context. Include specific facts, figures, and recent developments mentioned in the context. If the context doesn't contain all the necessary information, you may supplement with your general knowledge, but prioritize the provided context.

Do not mention the sources of your information or that you're using any specific context. Simply provide the most up-to-date and accurate answer possible, as if you inherently know this information.`,
  };

  const mergedOptions = { ...defaultOptions, ...options };
  const fullPrompt = mergedOptions.prompt;

  const response = await ollama.chat({
    ...mergedOptions,
    messages: [{ role: 'user', content: fullPrompt }],
  });
  return response.message.content;
}

async function rephraseForSearch(prompt) {
  const rephrasePrompt = `Rephrase the following question into a short, concise search query that will yield the most relevant results from a search engine. The query should be 2-15 words long and focused on gathering information to answer the original question. Do not include explanations or multiple options, just provide the best single search query.

Original question: "${prompt}"

Rephrased search query:`;

  const response = await ollama.chat({
    model: OLLAMA_MODEL,
    messages: [{ role: 'user', content: rephrasePrompt }],
  });
  
  // Extract only the first line of the response
  const searchQuery = response.message.content.split('\n')[0].trim();
  
  // If the search query is still too long, truncate it
  return searchQuery.length > 50 ? searchQuery.substring(0, 50) : searchQuery;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node main.js <prompt>");
    process.exit(1);
  }

  const originalPrompt = args.join(" ");
  const spinner = ora('Processing').start();

  try {
    // Clear out previous content in error_log.txt
    await fs.writeFile(`${__dirname}/error_log.txt`, '', 'utf8');

    // Step 1: Rephrase the prompt for better search results
    spinner.text = 'Rephrasing prompt for search';
    let searchPrompt = await rephraseForSearch(originalPrompt);
    
    // If the rephrased query is not significantly different or shorter, use the original
    if (searchPrompt.length > originalPrompt.length * 0.8 || searchPrompt === originalPrompt) {
      searchPrompt = originalPrompt;
    }
    
    let fullLog = `Original prompt: ${originalPrompt}\nRephrased search query: ${searchPrompt}\n\n`;

    // Step 2: Search web using SearXNG with the rephrased prompt
    spinner.text = 'Searching the web';
    await setTimeout(5000); // Add delay before search
    const searchResults = await searchWeb(searchPrompt);
    fullLog += `Search results:\n${searchResults.join('\n')}\n\n`;

    // Step 3: Scrape content from each URL
    let combinedContent = "";
    for (const url of searchResults) {
      spinner.text = `Fetching content from ${url}`;
      const content = await fetchWebContent(url);
      const trimmedContent = content.trim();
      if (trimmedContent) {
        const summarizedContent = summarizeContent(trimmedContent);
        combinedContent += `Content from ${url}:\n\n${summarizedContent}\n\n`;
        fullLog += `Content from ${url}:\n\n${trimmedContent}\n\n---\n\n`;
      } else {
        fullLog += `No content could be extracted from ${url}\n\n---\n\n`;
      }
    }

    if (combinedContent.trim().length === 0) {
      combinedContent = "No relevant information found from web search.";
      fullLog += "No relevant information found from web search.\n";
    }

    // Step 4: Create system prompt
    const systemPrompt = `You are a helpful assistant with access to the following information:

${combinedContent}

The original question was: "${originalPrompt}"
A rephrased version for search purposes was: "${searchPrompt}"

Using this information and your general knowledge, answer the original question directly and concisely:

${originalPrompt}

Provide your answer as if you inherently know the information, without referencing any sources or context. Do not mention any limitations in your knowledge or capabilities, and do not refer to your training data or cutoff date. Simply provide the most up-to-date and accurate information available to you.`;

    // Step 5: Log everything to txt
    fullLog += `\nSystem Prompt:\n${systemPrompt}\n\n`;
    await fs.writeFile(`${__dirname}/log.txt`, fullLog, 'utf8');

    // Step 6: Generate and write out the answer
    spinner.text = 'Generating response';
    let response = await generateWithContext(originalPrompt, combinedContent, { prompt: systemPrompt });
    
    // Check if the response is too short or doesn't contain specific information from the context
    if (response.length < 100 || !containsContextInfo(response, combinedContent)) {
      spinner.text = 'Regenerating response with emphasis on context';
      const regenerationPrompt = `Your previous answer did not sufficiently use the provided context. Please provide a more detailed explanation for the question: ${originalPrompt}\n\nEnsure you include specific information from the given context in your response.`;
      response = await generateWithContext(regenerationPrompt, combinedContent);
    }

    spinner.stop();
    console.log("\nGenerated response:");
    console.log(response);

    // Append the generated response to the log file
    await fs.appendFile(`${__dirname}/log.txt`, `\nGenerated response:\n${response}\n`);
  } catch (error) {
    spinner.fail('An error occurred');
    // Write fresh error information to error_log.txt
    await fs.writeFile(`${__dirname}/error_log.txt`, `${new Date().toISOString()}: ${error.stack}\n`, 'utf8');
    console.error("An error occurred. Check error_log.txt for details.");
  } finally {
    // Ensure the program exits
    process.exit(0);
  }
}

// Use top-level await to handle the promise rejection
try {
  await main();
} catch (error) {
  console.error("Unhandled error in main:", error);
  process.exit(1);
}

function summarizeContent(content, maxLength = 1000) {
  const sentences = content.split(/[.!?]+/);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length + sentence.length > maxLength) break;
    summary += sentence.trim() + ". ";
  }
  return summary.trim();
}

function containsContextInfo(response, context) {
  const contextKeywords = context.split(/\s+/).filter(word => word.length > 5);
  const uniqueKeywords = [...new Set(contextKeywords)];
  const keywordThreshold = Math.min(10, uniqueKeywords.length);
  let matchCount = 0;

  for (const keyword of uniqueKeywords) {
    if (response.toLowerCase().includes(keyword.toLowerCase())) {
      matchCount++;
      if (matchCount >= keywordThreshold) return true;
    }
  }

  return false;
}