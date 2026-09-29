FROM ghcr.io/cloud-cli/image-node:latest

WORKDIR /home/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Set default environment variables
ENV DATA_PATH=/data
ENV PORT=3000

# Create data directory
RUN mkdir -p $DATA_PATH

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "index.js"]
