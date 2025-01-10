const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  userName: { type: String, required: true },
  phoneNumber: { type: String, required: true, unique: true },
  chatId: { type: Number, unique: true, required: true }, // Ensure chatId is included
});

const bookSchema = new mongoose.Schema({
  id: Number,
  title: String,
  available: Boolean,
  language: String,
  category: String,
});

const reservationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  bookId: { type: mongoose.Schema.Types.ObjectId, ref: "Book" },
  pickupTime: String,
});

const User = mongoose.model("User", userSchema);
const Book = mongoose.model("Book", bookSchema);
const Reservation = mongoose.model("Reservation", reservationSchema);

module.exports = { User, Book, Reservation };
