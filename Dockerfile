FROM node:25-alpine

WORKDIR /app

# Copy only dependency files first (better caching)
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the app
COPY . .

EXPOSE 5000
CMD ["node", "index.js"]
