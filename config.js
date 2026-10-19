// RunTrack site configuration.
//
// Optional accounts use Firebase Authentication (Email/Password) and Cloud
// Firestore. These values identify the Firebase project behind this site. They
// are public client identifiers, not secrets: firestore.rules decides who can
// read and write data.
//
// Self-hosting: replace the values with the web app config from your own
// Firebase project, or set `firebase: null` to run RunTrack in guest-only mode
// with no accounts and no requests to Firebase.
window.RUNTRACK_CONFIG = {
  firebase: {
    apiKey:            'AIzaSyDDJCkZCqO9IWX17zJV85i_X3sx_WOjLNY',
    authDomain:        'runtrack404.firebaseapp.com',
    projectId:         'runtrack404',
    storageBucket:     'runtrack404.firebasestorage.app',
    messagingSenderId: '97566338423',
    appId:             '1:97566338423:web:15c3d19017028f1a0cc572'
  }
};
