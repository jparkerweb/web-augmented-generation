process.removeAllListeners('warning');

import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import ora from 'ora';
import https from 'https';
import * as cheerio from 'cheerio';
import { splitBySentence } from "string-segmenter"
import OpenAI from 'openai';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: `${__dirname}/.env` });

const SEARXNG_URL = process.env.SEARXNG_URL;
const NUM_URLS = parseInt(process.env.NUM_URLS) || 5;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS) || 5000;
const DISABLE_SSL_VALIDATION = process.env.DISABLE_SSL_VALIDATION === 'true';
const SEARXNG_FORMAT = process.env.SEARXNG_FORMAT || 'html';
const SEARXNG_URL_EXTRA_PARAMETER = process.env.SEARXNG_URL_EXTRA_PARAMETER || '';

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;

const runningFromAskScript = process.argv.includes('--from-ask-script');

if (!SEARXNG_URL) {
  console.error("SEARXNG_URL is not set. Please check your .env file.");
  process.exit(1);
}

/* --------------------- */
/* -- fallbackSearch -- */
/* --------------------- */
/* -- Implements a fallback search method when the primary search fails -- */
/* ---------------------------------------- */
async function fallbackSearch(query) {
  // Implement a fallback search method here
  // This could be a different search API or a simpler web scraping approach
  console.warn("Using fallback search method");
  // Return an array of URLs or an empty array if no results
}

/* --------------------- */
/* -- searchWeb -- */
/* --------------------- */
/* -- Searches the web using SearXNG and returns a list of URLs -- */
/* ---------------------------------------- */
async function searchWeb(query) {
  const searchUrl = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}${SEARXNG_FORMAT === 'json' ? '&format=json' : ''}${SEARXNG_URL_EXTRA_PARAMETER ? '&' + SEARXNG_URL_EXTRA_PARAMETER : ''}`;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      // console.log(` Attempt ${attempt + 1}: Status ${response.status}`);

      if (response.status === 429) { // Too Many Requests
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Rate limited. Retrying in ${backoffTime}ms...`);
        await delay(backoffTime);
        continue;
      }

      // Log headers for debugging
      // console.log(" ⇢ Response headers:", Object.fromEntries(response.headers.entries()));

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
      await delay(backoffTime);
    }
  }
}

/* --------------------- */
/* -- extractLinksFromHTML -- */
/* --------------------- */
/* -- Extracts links from HTML content using Cheerio -- */
/* ---------------------------------------- */
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

/* --------------------- */
/* -- fetchWebContent -- */
/* --------------------- */
/* -- Fetches and extracts the main content from a given URL -- */
/* ---------------------------------------- */
async function fetchWebContent(url) {
  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), FETCH_TIMEOUT_MS)
    );

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

/* --------------------- */
/* -- generateWithContext -- */
/* --------------------- */
/* -- Generates a response using an AI model with given context -- */
/* ---------------------------------------- */
async function generateWithContext(prompt, context, options = {}) {
  const defaultOptions = {
    model: LLM_MODEL,
    prompt: `You are a helpful assistant with access to the following information:

${context}

This information is current and factual. Your task is to use this information to answer the following question:

${prompt}

Provide a detailed and informative answer based primarily on the given context. Include specific facts, figures, and recent developments mentioned in the context. If the context doesn't contain all the necessary information, you may supplement with your general knowledge, but prioritize the provided context.

Do not mention the sources of your information or that you're using any specific context. Simply provide the most up-to-date and accurate answer possible, as if you inherently know this information.`,
  };

  const mergedOptions = { ...defaultOptions, ...options };
  const fullPrompt = mergedOptions.prompt;

  const openai = new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });

  try {
    const response = await openai.chat.completions.create({
      model: mergedOptions.model,
      messages: [{ role: 'user', content: fullPrompt }],
      temperature: 0.1,
      stream: false
    });

    let responseObj = response;
    if (typeof response === 'string' && response.includes('choices')) {
      try {
        responseObj = JSON.parse(response);
      } catch (error) {
        console.error('Failed to parse response string to object:', error);
        throw error;
      }
    }
    return responseObj.choices[0].message.content;
  } catch (error) {
    console.error(`Error in generateWithContext: ${error.message}`);
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
      console.error(`Response data: ${JSON.stringify(error.response.data)}`);
    }
    throw error; // Re-throw the error to be caught in the main function
  }
}

/* --------------------- */
/* -- rephraseForSearch -- */
/* --------------------- */
/* -- Rephrases a given prompt into a concise search query -- */
/* ---------------------------------------- */
async function rephraseForSearch(prompt) {
  const rephrasePrompt = `Rephrase the following question into a short, concise search query that will yield the most relevant results from a search engine. The query should be 2-15 words long and focused on gathering information to answer the original question. Do not include explanations or multiple options, just provide the best single search query.

Original question: "${prompt}"

Rephrased search query:`;

  const openai = new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });

  const response = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: 'user', content: rephrasePrompt }],
    temperature: 0.1,
    stream: false
  });

  let responseObj = response;
  if (typeof response === 'string' && response.includes('choices')) {
    try {
      responseObj = JSON.parse(response);
    } catch (error) {
      console.error('Failed to parse response string to object:', error);
      throw error;
    }
  }
  const searchQuery = responseObj.choices[0].message.content.split('\n')[0].trim();
  return searchQuery.length > 50 ? searchQuery.substring(0, 50) : searchQuery;
}

/* --------------------- */
/* -- countdown -- */
/* --------------------- */
/* -- Displays a countdown timer and waits for any key press -- */
/* ---------------------------------------- */
function countdown(seconds) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let remainingSeconds = seconds;

    console.log(`\nPress any key to exit or wait ${seconds} seconds...`);

    const timer = setInterval(() => {
      process.stdout.write(`\r${remainingSeconds} seconds remaining...`);
      remainingSeconds--;

      if (remainingSeconds < 0) {
        clearInterval(timer);
        rl.close();
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        resolve('timeout');
      }
    }, 1000);

    process.stdin.on('keypress', () => {
      clearInterval(timer);
      rl.close();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      resolve('keypress');
    });
  });
}

/* --------------------- */
/* -- main -- */
/* --------------------- */
/* -- Orchestrates the web search and response generation process -- */
/* ---------------------------------------- */
async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--from-ask-script');
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
    await delay(500); // Add delay before search
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

    // Only run the countdown if executed from an ask script
    if (runningFromAskScript) {
      console.log("\n");
      const result = await countdown(60);
      if (result === 'keypress') {
        console.log('\n');
      }
    }
  } catch (error) {
    spinner.fail('An error occurred');
    // Write fresh error information to error_log.txt
    await fs.writeFile(`${__dirname}/error_log.txt`, `${new Date().toISOString()}: ${error.stack}\n`, 'utf8');
    console.error("An error occurred. Check error_log.txt for details.");
  } finally {
    // Ensure the process exits
    process.exit(0);
  }
}

if (runningFromAskScript) {
  try {
    await main();
  } catch (error) {
    console.error("Unhandled error in main:", error);
  }
} else {
  main().catch(error => {
    console.error("Unhandled error in main:", error);
    process.exit(1);
  });
}

/* --------------------- */
/* -- summarizeContent -- */
/* --------------------- */
/* -- Summarizes content by truncating to a specified maximum length -- */
/* ---------------------------------------- */
function summarizeContent(content, maxLength = 1000) {
  const sentences = []
  for (const { segment } of splitBySentence(content)) {
    sentences.push(segment.trim())
  }

  let summary = "";
  for (const sentence of sentences) {
    if (summary.length + sentence.length > maxLength) break;
    summary += sentence.trim() + ". ";
  }
  return summary.trim();
}

/* --------------------- */
/* -- containsContextInfo -- */
/* --------------------- */
/* -- Checks if the generated response contains sufficient information from the context -- */
/* ---------------------------------------- */
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

/* --------------------- */
/* -- delay -- */
/* --------------------- */
/* -- Utility function to introduce a delay -- */
/* ---------------------------------------- */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}