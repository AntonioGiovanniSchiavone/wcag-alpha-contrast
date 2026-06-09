# wcag-alpha-contrast crawler
# Dockerized environment for reproducible web crawling and analysis.
#
# Build:  docker build -t wcag-alpha-contrast .
# Run:    docker run -v $(pwd)/data:/app/data wcag-alpha-contrast npm run crawl:200
# Shell:  docker run -it -v $(pwd)/data:/app/data wcag-alpha-contrast bash

FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production=false 2>/dev/null || npm install

# Install Playwright browsers (Chromium only — saves space)
RUN npx playwright install chromium

# Copy project files
COPY . .

# Create data directory for results
RUN mkdir -p /app/data

# Run tests to verify installation
RUN node test/test.js

# Default: run the 200-site crawl
CMD ["npm", "run", "crawl:200"]
