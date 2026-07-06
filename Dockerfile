FROM node:alpine
WORKDIR /app
COPY honeypot.js .
USER node
ENTRYPOINT [ "node", "honeypot.js" ]