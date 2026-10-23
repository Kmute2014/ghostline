
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const frontendUrl = process.env.FRONTEND_URL;

app.use(
  cors({
    origin: frontendUrl,
    methods: ["GET", "POST"]
  })
);

app.get("/", (req, res) => {
  res.json({
    service: "Ghostline Realtime",
    status: "online"
  });
});

const io = new Server(server, {
  cors: {
    origin: frontendUrl,
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Realtime server running on port ${PORT}`);
});
