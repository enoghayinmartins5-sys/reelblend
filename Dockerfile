# ReelBlend is dependency-free, so the image is just Node + this project.
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/index.js"]
