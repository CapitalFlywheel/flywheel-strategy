FROM node:22-alpine
WORKDIR /app
ARG VITE_REOWN_PROJECT_ID=""
ENV VITE_REOWN_PROJECT_ID=$VITE_REOWN_PROJECT_ID
COPY package.json package-lock.json ./
RUN npm ci
COPY hardhat.config.js ./
COPY contracts ./contracts
RUN npm run compile
COPY . .
RUN npm run web:build && npx tsc --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit
RUN mkdir -p /app/node_modules/.vite && chown -R node:node /app/cache /app/artifacts /app/node_modules/.vite
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "web:serve"]
