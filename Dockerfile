FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY webhook-server.js .
EXPOSE 3000
CMD ["node", "webhook-server.js"]