#!/bin/bash

# Clear the console
clear

# Get the directory of the script
script_dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
parent_dir="$( cd "$script_dir/.." && pwd )"

# Prompt the user for input
echo "Enter your prompt:"
read user_prompt

# Run main.js with the user's prompt and the --from-ask-script flag
node --no-warnings "$parent_dir/main.js" --from-ask-script "$user_prompt"
