# Clear the console
Clear-Host

# Get the directory of the script
$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$parent_dir = Split-Path -Parent $script_dir

# Prompt the user for input
$user_prompt = Read-Host "Enter your prompt"

# Run main.js with the user's prompt and the --from-ask-script flag
node --no-warnings "$parent_dir\main.js" --from-ask-script $user_prompt
