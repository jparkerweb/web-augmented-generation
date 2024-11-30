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
import { createInterface } from 'readline';
import chalk from 'chalk';
import path from 'path';
import { matchChunks } from 'chunk-match';
import llama3Tokenizer from 'llama3-tokenizer-js'

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

/* -------------------- */
/* -- fallbackSearch -- */
/* ----------------------------------------------------------------------- */
/* -- Implements a fallback search method when the primary search fails -- */
/* ----------------------------------------------------------------------- */
async function fallbackSearch(query) {
  // Implement a fallback search method here
  // This could be a different search API or a simpler web scraping approach
  console.warn("Using fallback search method");
  // Return an array of URLs or an empty array if no results
}

/* --------------- */
/* -- searchWeb -- */
/* --------------------------------------------------------------- */
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

/* -------------------------- */
/* -- extractLinksFromHTML -- */
/* ---------------------------------------------------- */
/* -- Extracts links from HTML content using Cheerio -- */
/* ---------------------------------------------------- */
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
/* ------------------------------------------------------------ */
/* -- Fetches and extracts the main content from a given URL -- */
/* ------------------------------------------------------------ */
async function fetchWebContent(url) {
  try {
    // Create a promise that rejects after a specified timeout period
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), FETCH_TIMEOUT_MS)
    );

    const fetchPromise = (async () => {
      // Set up an HTTPS agent if SSL validation is disabled
      const agent = DISABLE_SSL_VALIDATION ? new https.Agent({ rejectUnauthorized: false }) : undefined;
      
      // Fetch the URL content
      const response = await fetch(url, { agent });
      
      // Get the HTML text from the response
      const html = await response.text();
      
      // Set up a virtual console to suppress errors during DOM parsing
      const virtualConsole = new VirtualConsole();
      virtualConsole.on("error", () => { /* Ignore errors */ });
      
      // Create a JSDOM instance to parse the HTML
      const dom = new JSDOM(html, { 
        url,
        runScripts: "outside-only",
        resources: "usable",
        virtualConsole
      });
      
      // Use Readability to extract the main content from the document
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      
      // Return the extracted text content or an empty string if parsing fails
      return article ? article.textContent : "";
    })();

    // Race the fetch promise against the timeout promise
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    
    // Check if the result was a timeout
    if (result === 'Timeout') {
      // Log the timeout error and return an empty string
      await logError(`Timeout fetching content from ${url} (${FETCH_TIMEOUT_MS}ms)`);
      return "";
    }
    
    // Process the result to remove extra line breaks and trim unnecessary spaces
    return result
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (error) {
    // Log any errors encountered during the fetch process
    await logError(`Error fetching content from ${url}: ${error.message}`);
    return "";
  }
}

/* -------------- */
/* -- logError -- */
/* ------------------------------------------- */
/* -- Logs errors to the error_log.txt file -- */
/* ------------------------------------------- */
async function logError(message) {
  const errorLogPath = path.join(__dirname, 'error_log.txt');
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp}: ${message}\n`;
  
  try {
    await fs.appendFile(errorLogPath, logMessage);
  } catch (error) {
    console.error(`Failed to write to error log: ${error.message}`);
  }
}

/* ------------- */
/* -- logInfo -- */
/* ----------------------------------------- */
/* -- Logs information to the log.txt file -- */
/* ----------------------------------------- */
async function logInfo(content) {
  const logPath = path.join(__dirname, 'log.txt');
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp}\n${content}\n\n`;
  
  try {
    await fs.appendFile(logPath, logMessage);
  } catch (error) {
    console.error(`Failed to write to log file: ${error.message}`);
  }
}

/* ------------------------- */
/* -- generateWithContext -- */
/* --------------------------------------------------------------- */
/* -- Generates a response using an AI model with given context -- */
/* --------------------------------------------------------------- */
async function generateWithContext(prompt, context, options = {}) {
  const defaultOptions = {
    model: LLM_MODEL,
    prompt: `You are a helpful assistant with access to the following information:

${context}

This information is current and factual. Your task is to use this information to answer the following question:

${prompt}

Provide a detailed and informative answer based primarily on the given context. Include specific facts, figures, and recent developments mentioned in the context. If the context doesn't contain all the necessary information, you may supplement with your general knowledge, but prioritize the provided context.

Do not mention the sources of your information or that you're using any specific context. Simply provide the most up-to-date and accurate answer possible, as if you inherently know this information.`,
    maxTokens: 2000, // Default max tokens
    repetitionThreshold: 0.5 // Default repetition threshold
  };

  const mergedOptions = { ...defaultOptions, ...options };
  const fullPrompt = mergedOptions.prompt;

  const openai = new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });

  try {
    const streamResponse = process.env.LLM_STREAM_RESPONSE === 'true';

    if (streamResponse) {
      const stream = await openai.chat.completions.create({
        model: mergedOptions.model,
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.1,
        max_tokens: mergedOptions.maxTokens,
        stream: true
      });

      let fullResponse = '';
      console.log(chalk.green('\nResponse:'));

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (isRepetitive(fullResponse, content, mergedOptions.repetitionThreshold)) {
          console.log(chalk.red('\nWhoa there! We had to cut off the robot. It was running in circles like a dog chasing its tail!'));
          break;
        }
        fullResponse += content;
        process.stdout.write(chalk.whiteBright(content));
        
        if (fullResponse.length >= mergedOptions.maxTokens) {
          console.log(chalk.red('\nHold your horses! We had to rein in the robot. It was about to write a novel!'));
          break;
        }
      }

      console.log('\n'); // Add a newline after the streamed response
      return fullResponse;
    } else {
      const response = await openai.chat.completions.create({
        model: mergedOptions.model,
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.1,
        max_tokens: mergedOptions.maxTokens,
        stream: false
      });

      const fullResponse = typeof response === 'string' 
        ? JSON.parse(response).choices[0].message.content
        : response.choices[0].message.content;
      console.log(chalk.green('\nResponse:'));
      console.log(chalk.whiteBright(fullResponse));
      
      if (fullResponse.length >= mergedOptions.maxTokens) {
        console.log(chalk.red('\nPhew! We had to put the brakes on our chatty robot. It was about to break the internet!'));
      }
      
      console.log('\n');
      return fullResponse;
    }
  } catch (error) {
    console.error(chalk.red(`Error in generateWithContext: ${error.message}`));
    if (error.response) {
      console.error(chalk.red(`Response status: ${error.response.status}`));
      console.error(chalk.red(`Response data: ${JSON.stringify(error.response.data)}`));
    }
    throw error;
  }
}

/* ------------------ */
/* -- isRepetitive -- */
/* --------------------------------------------- */
/* -- Checks if the new content is repetitive -- */
/* --------------------------------------------- */
function isRepetitive(existingContent, newContent, threshold) {
  if (existingContent.length === 0) return false;
  
  const lastChunk = existingContent.slice(-newContent.length);
  const similarity = calculateSimilarity(lastChunk, newContent);
  
  return similarity > threshold;
}

/* ------------------------- */
/* -- calculateSimilarity -- */
/* --------------------------------------------------- */
/* -- Calculates the similarity between two strings -- */
/* --------------------------------------------------- */
function calculateSimilarity(str1, str2) {
  const set1 = new Set(str1.toLowerCase().split(' '));
  const set2 = new Set(str2.toLowerCase().split(' '));
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/* ----------------------- */
/* -- rephraseForSearch -- */
/* ---------------------------------------------------------- */
/* -- Rephrases a given prompt into a concise search query -- */
/* ---------------------------------------------------------- */
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
  let searchQuery;
  if (responseObj.error) {
    const errorMessage = JSON.stringify(responseObj.error, null, 2);
    await logError(`LLM API Error during rephraseForSearch: ${errorMessage}`);
    throw new Error(`LLM API Error: ${errorMessage}`);
  } else if (responseObj.choices?.[0]?.message?.content) {
    searchQuery = responseObj.choices[0].message.content.split('\n')[0].trim();
  } else {
    const errorMessage = `Unexpected response format from LLM API: ${JSON.stringify(responseObj, null, 2)}`;
    await logError(errorMessage);
    throw new Error(errorMessage);
  }
  return searchQuery.length > 50 ? searchQuery.substring(0, 50) : searchQuery;
}

/* --------------- */
/* -- countdown -- */
/* -------------------------------------------------------------*/
/* -- Displays a countdown timer and waits for any key press -- */
/* -------------------------------------------------------------*/
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

/* ---------- */
/* -- main -- */
/* ----------------------------------------------------------------- */
/* -- Orchestrates the web search and response generation process -- */
/* ----------------------------------------------------------------- */
async function main() {
  let args = process.argv.slice(2).filter(arg => arg !== '--from-ask-script');
  let originalPrompt;

  if (args.length < 1) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    originalPrompt = await new Promise(resolve => {
      rl.question(chalk.cyan('Please enter your prompt: '), answer => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (!originalPrompt) {
      console.error(chalk.red("No prompt provided. Exiting."));
      process.exit(1);
    }
  } else {
    originalPrompt = args.join(" ");
  }

  // ---------------
  // -- ascii art --
  // ---------------
  const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const randomColor = colors[Math.floor(Math.random() * colors.length)];
  console.log(chalk[randomColor](`
▐▓█▀▀▀▀▀▀▀▀▀█▓▌░▄▄▄▄▄░
▐▓█░░W░A░G░░█▓▌░█▄▄▄█░
▐▓█░░░░░░░░░█▓▌░█▄▄▄█░
▐▓█▄▄▄▄▄▄▄▄▄█▓▌░█████░
░░░░▄▄███▄▄░░░░░█████░ 
`));

  const spinner = ora('Processing').start();

  try {
    // Clear out previous content in error_log.txt and log.txt
    await fs.writeFile(`${__dirname}/error_log.txt`, '', 'utf8');
    await fs.writeFile(`${__dirname}/log.txt`, '', 'utf8');

    // -------------
    // -- Step 1: ----------------------------------------
    // -- Rephrase the prompt for better search results --
    // ---------------------------------------------------
    spinner.text = 'Rephrasing prompt for search';
    let searchPrompt = await rephraseForSearch(originalPrompt);
    
    // If the rephrased query is not significantly different or shorter, use the original
    if (searchPrompt.length > originalPrompt.length * 0.8 || searchPrompt === originalPrompt) {
      searchPrompt = originalPrompt;
    }
    
    let fullLog = `Original prompt:\n${originalPrompt}\nRephrased search query: ${searchPrompt}\n\n`;
    await logInfo(fullLog);

    // -------------
    // -- Step 2: ---------------------------------------------
    // -- Search web using SearXNG with the rephrased prompt --
    // --------------------------------------------------------
    spinner.text = 'Searching the web';
    await delay(500); // Add delay before search
    const searchResults = await searchWeb(searchPrompt);
    fullLog = `Search results:\n${searchResults.join('\n')}\n\n`;
    await logInfo(fullLog);

    // -------------
    // -- Step 3: -----------------------
    // -- Scrape content from each URL --
    // ----------------------------------
    let combinedContent = "";
    
    // First log all raw content
    for (const url of searchResults) {
      spinner.text = `Fetching content from ${url}`;
      const content = await fetchWebContent(url);
      const trimmedContent = content.trim();
      if (trimmedContent) {
        fullLog = `Raw Content from ${url}:\n\n${trimmedContent}\n\n---\n\n`;
        await logInfo(fullLog);
      }
    }

    // Then process and collect summarized content
    for (const url of searchResults) {
      spinner.text = `Processing content from ${url}`;
      const content = await fetchWebContent(url);
      const trimmedContent = content.trim();
      if (trimmedContent) {
        let summarizedContent;
        // if the `CHUNK_CONTENT` environment variable is set to `true`, use semantic chunk matching to summarize the content
        if (process.env.CHUNK_CONTENT === 'true') {
          summarizedContent = await chunkMatchContent(trimmedContent, searchPrompt);
          // If hybrid mode is enabled and chunk matching didn't return content, fall back to summarizeContent
          if (process.env.CHUNK_CONTENT_USE_HYBRID_FALLBACK === 'true' && (!summarizedContent || summarizedContent.trim().length === 0)) {
            summarizedContent = summarizeContent(trimmedContent, parseInt(process.env.CHUNK_CONTENT_MAX_TOKEN_SIZE) || 500);
          }
        } else {
          // otherwise, use a simple truncation method to summarize the content
          summarizedContent = summarizeContent(trimmedContent, process.env.WEB_PAGE_CONTENT_MAX_LENGTH);
        }
        if (summarizedContent.length > 0) {
          combinedContent += `Content from ${url}:\n\n${summarizedContent}\n\n`;
        }
      }
    }

    if (combinedContent.trim().length === 0) {
      combinedContent = "No relevant information found from web search.";
      fullLog = "No relevant information found from web search.\n";
      await logInfo(fullLog);
    }

    // -------------
    // -- Step 4: ---------------
    // -- Create system prompt --
    // --------------------------
    const systemPrompt = `You are a helpful assistant with access to the following information:

${combinedContent}

The original question was: "${originalPrompt}"
A rephrased version for search purposes was: "${searchPrompt}"

Using this information and your general knowledge, answer the original question directly and concisely:

${originalPrompt}

Provide your answer as if you inherently know the information, without referencing any sources or context. Do not mention any limitations in your knowledge or capabilities, and do not refer to your training data or cutoff date. Simply provide the most up-to-date and accurate information available to you.`;

    // Log the processed content that will be sent to the LLM
    fullLog = `Content Being Sent to LLM:\n\n${combinedContent}\n\n`;
    await logInfo(fullLog);

    fullLog = `\n\n/* ------------------------------------ */
/* ----------- SYSTEM PROMPT ---------- */
/* ------------------------------------ */

${systemPrompt}

/* ------------------------------------ */
/* -------- END SYSTEM PROMPT --------- */
/* ------------------------------------ */\n\n`;
    await logInfo(fullLog);

    // -------------
    // -- Step 4: ----------------------------
    // -- Generate and write out the answer --
    // ---------------------------------------
    spinner.stop(); // Stop the spinner before streaming
    let response = await generateWithContext(originalPrompt, combinedContent, { prompt: systemPrompt });
    
    // Check if the response is too short or doesn't contain specific information from the context
    if (response.length < 100 || !containsContextInfo(response, combinedContent)) {
      console.log(chalk.yellow('Expanded response with emphasis on context:'));
      const regenerationPrompt = `Your previous answer did not sufficiently use the provided context. Please provide a more detailed explanation for the question: ${originalPrompt}\n\nEnsure you include specific information from the given context in your response.`;
      response = await generateWithContext(regenerationPrompt, combinedContent);
    }

    // Append the generated response to the log file
    await fs.appendFile(`${__dirname}/log.txt`, `\nGenerated response:\n${response}\n`);

    // calculate the token count of `systemPrompt` + `response`
    const tokenCount = llama3Tokenizer.encode(systemPrompt + response);
    console.log(chalk.blue(`\nTokens sent to LLM: ${tokenCount.length}`));
    await fs.appendFile(`${__dirname}/log.txt`, `\nTokens sent to LLM: ${tokenCount.length}\n`, 'utf8');

    // Only run the countdown if executed from an ask script
    if (runningFromAskScript) {
      console.log("\n");
      const result = await countdown(60 * 3);
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

// -------------------------
// -- chunk-match content --
// -------------------------
async function chunkMatchContent(content, query) {
  // set the options for the chunk-match library
  const options = {
    maxResults: parseInt(process.env.CHUNK_CONTENT_MAX_RESULTS) || 5,
    minSimilarity: parseFloat(process.env.CHUNK_CONTENT_MIN_SIMILARITY) || 0.475,
    chunkingOptions: {
        maxTokenSize: 500,
        similarityThreshold: parseFloat(process.env.CHUNK_CONTENT_SIMILARITY_THRESHOLD) || 0.5,
        dynamicThresholdLowerBound: parseFloat(process.env.CHUNK_CONTENT_DYNAMIC_THRESHOLD_LOWER_BOUND) || 0.4,
        dynamicThresholdUpperBound: parseFloat(process.env.CHUNK_CONTENT_DYNAMIC_THRESHOLD_UPPER_BOUND) || 0.8,
        numSimilaritySentencesLookahead: parseInt(process.env.CHUNK_CONTENT_NUM_SIMILARITY_SENTENCES_LOOKAHEAD) || 3,
        combineChunks: process.env.CHUNK_CONTENT_COMBINE_CHUNKS === 'true',
        combineChunksSimilarityThreshold: parseFloat(process.env.CHUNK_CONTENT_COMBINE_CHUNKS_SIMILARITY_THRESHOLD) || 0.6,
        onnxEmbeddingModel: process.env.CHUNK_CONTENT_ONNX_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
        dtype: process.env.CHUNK_CONTENT_DTYPE || "q8"
    }
  };

  // call `chunk-match` library to return semantically similar chunks of content from the scraped web content
  const chunks = await matchChunks(
    [{ document_name: 'content', document_text: content }],
    query,
    options
  );

  // concatenate the chunks into a single string
  let chunkMatchedContent = "";
  for (const doc of chunks) {
    chunkMatchedContent += doc.chunk;
  }

  // return the concatenated chunks
  return chunkMatchedContent;
}

/* ---------------------- */
/* -- summarizeContent -- */
/* -------------------------------------------------------------------- */
/* -- Summarizes content by truncating to a specified maximum length -- */
/* -------------------------------------------------------------------- */
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

/* ------------------------- */
/* -- containsContextInfo -- */
/* --------------------------------------------------------------------------------------- */
/* -- Checks if the generated response contains sufficient information from the context -- */
/* --------------------------------------------------------------------------------------- */
function containsContextInfo(response, context) {
  // Split the context into words and filter out short words (<= 5 characters)
  const contextKeywords = context.split(/\s+/).filter(word => word.length > 5);
  
  // Remove duplicate keywords
  const uniqueKeywords = [...new Set(contextKeywords)];
  
  // Set a threshold for the minimum number of keyword matches required
  const keywordThreshold = Math.min(10, uniqueKeywords.length);
  
  let matchCount = 0;

  // Check if the response contains each keyword
  for (const keyword of uniqueKeywords) {
    if (response.toLowerCase().includes(keyword.toLowerCase())) {
      matchCount++;
      // If the match count reaches the threshold, return true
      if (matchCount >= keywordThreshold) return true;
    }
  }

  // If the match count does not reach the threshold, return false
  return false;
}

/* ----------- */
/* -- delay -- */
/* ------------------------------------------- */
/* -- Utility function to introduce a delay -- */
/* ------------------------------------------- */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}