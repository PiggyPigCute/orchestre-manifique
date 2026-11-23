git pull
npm install --omit=dev
pm2 reload orma-photos || PORT=3010 pm2 start server.js --name orma-photos
