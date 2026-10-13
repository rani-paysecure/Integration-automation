# Test Launcher (Integration QA Automation) – server image.
# Playwright's image: Node + Chromium + all browser libraries, same version as package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Dependencies first (cached layer). Dev dependencies are needed: @playwright/test runs the suites.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .

# Everything that changes at run time lives in volumes (see docker-compose.yml):
#   /data         settings, testers, 3DS flow files, uploaded cases, bank profiles, tokens (.env)
#   /app/reports  report history
RUN mkdir -p /data /app/reports /app/test-results /app/playwright/.auth \
  && chmod +x docker/entrypoint.sh \
  && chown -R pwuser:pwuser /data /app

ENV LAUNCHER_HOST=0.0.0.0 \
    LAUNCHER_PORT=4173 \
    LAUNCHER_DATA_DIR=/data \
    UPLOADED_CASES_DIR=/data/uploaded-cases \
    BANK_PROFILES_FILE=/data/bank-profiles.json \
    LAUNCHER_HEADLESS_ONLY=1 \
    LAUNCHER_ENVIRONMENTS=uat

USER pwuser
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LAUNCHER_PORT||4173)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker/entrypoint.sh"]
