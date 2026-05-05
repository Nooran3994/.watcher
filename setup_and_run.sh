#!/bin/bash
echo "============================================"
echo " SCAAI Desktop - One-Click Setup"
echo "============================================"
echo ""
echo "Step 1: Installing Electron..."
npm install
echo ""
echo "Step 2: Installing React (local offline copy)..."
npm install react react-dom @babel/standalone
echo ""
echo "============================================"
echo " Setup complete! Launching SCAAI..."
echo "============================================"
echo ""
npm start
