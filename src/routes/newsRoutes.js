const express = require("express");
const { listNews } = require("../controllers/newsController");

const router = express.Router();

router.get("/", listNews);

module.exports = router;
