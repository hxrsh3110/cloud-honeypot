FROM node:20-alpine
WORKDIR /app
COPY honeypot.js .
USER node
ENTRYPOINT [ "node", "honeypot.js" ]