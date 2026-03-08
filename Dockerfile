FROM node:25

WORKDIR /app

# Install GStreamer dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-bad && \
    rm -rf /var/lib/apt/lists/*

# Copy only dependency files first (better caching)
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the app
COPY . .

EXPOSE 5000
CMD ["node", "index.js"]
