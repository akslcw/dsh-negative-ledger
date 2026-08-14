#!/bin/sh
if [ -f flag.txt ]; then
  echo FLAKE-OK-7K3Q
  exit 0
else
  echo FLAKE-FAIL
  exit 1
fi
