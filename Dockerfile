FROM node:alpine
WORKDIR /app
COPY honeypot.js .
ENTRYPOINT [ "node", "honeypot.js" ]