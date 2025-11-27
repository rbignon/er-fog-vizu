#!/usr/bin/env python3
"""
Build index.html with embedded demo data.

Usage:
    python build_with_demo.py [log_file]

If no log file is specified, uses the first *_log_*.txt file found.
Outputs to index.html (overwrites the placeholder).
"""

import json
import sys
from pathlib import Path
from parse_log import parse_spoiler_log, graph_to_json


def main():
    # Find log file
    if len(sys.argv) > 1:
        log_file = Path(sys.argv[1])
    else:
        log_files = list(Path('.').glob('*_log_*.txt'))
        if not log_files:
            print("No log file found. Usage: python build_with_demo.py <log_file>")
            sys.exit(1)
        log_file = log_files[0]
    
    print(f"Using log file: {log_file}")
    
    # Parse log
    graph = parse_spoiler_log(log_file)
    graph_json = graph_to_json(graph)
    
    print(f"Parsed {len(graph_json['nodes'])} areas, {len(graph_json['links'])} connections")
    
    # Read index.html
    index_path = Path('index.html')
    if not index_path.exists():
        print("index.html not found!")
        sys.exit(1)
    
    html_content = index_path.read_text(encoding='utf-8')
    
    # Replace placeholder with actual data
    json_str = json.dumps(graph_json, ensure_ascii=False)
    
    # Replace the placeholder line
    old_line = 'const DEMO_DATA = null; // DEMO_DATA_PLACEHOLDER'
    new_line = f'const DEMO_DATA = {json_str};'
    
    if old_line not in html_content:
        print("Warning: Placeholder not found. Demo data may already be embedded.")
        # Try to find existing DEMO_DATA and replace it
        import re
        # Match from 'const DEMO_DATA = ' to end of line (the JSON is all on one line)
        pattern = r'const DEMO_DATA = .*$'
        if re.search(pattern, html_content, re.MULTILINE):
            html_content = re.sub(pattern, new_line, html_content, flags=re.MULTILINE)
            print("Replaced existing DEMO_DATA.")
        else:
            print("Could not find DEMO_DATA declaration!")
            sys.exit(1)
    else:
        html_content = html_content.replace(old_line, new_line)
    
    # Write back
    index_path.write_text(html_content, encoding='utf-8')
    
    # Calculate size
    size_kb = len(html_content) / 1024
    print(f"Written index.html ({size_kb:.1f} KB)")
    print("Demo data embedded successfully!")


if __name__ == "__main__":
    main()

