FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/
RUN mkdir -p uploads/videos uploads/thumbnails uploads/avatars
EXPOSE 3000
CMD ["node", "src/server.js"]
