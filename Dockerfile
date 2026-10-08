FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
COPY lib ./lib
USER node
CMD ["node", "index.js"]
