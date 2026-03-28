#!/bin/bash
# Fetch the full GOP Predators WordPress table and save raw text
curl -s 'https://goppredators.wordpress.com/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \
  | sed 's/<\/tr>/\n/g' \
  | sed 's/<[^>]*>//g' \
  | sed '/^$/d' \
  | grep -E '^[0-9]{1,4}' \
  > data/goppredators-full.txt
echo "Done. Lines: $(wc -l < data/goppredators-full.txt)"
