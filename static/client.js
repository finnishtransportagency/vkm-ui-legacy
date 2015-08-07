$(function() {
  var fileName = window.location.hash.substring(1);
  if (fileName) { pollResponse(fileName); }

  var loader = $("#loading");
  function pollResponse(res) {
    $.ajax("/status/" + res, {
      statusCode: {
        200: function() {
          loader.addClass("hidden");
          $("#download").attr("href", downloadUrl(res)).removeClass("hidden");
          $("#reload").removeClass("hidden");
        },
        202: function() {
          loader.removeClass('hidden');
          setTimeout(function() { pollResponse(res); }, 1000);
        },
        500: function() {
          loader.addClass("hidden");
          $("#error").removeClass("hidden");
        }
      }
    });
  }

  $('#upload').on('submit', function(event) {
    event.preventDefault();

    loader.removeClass('hidden');

    $.ajax({
      url: '/upload',
      type: 'POST',
      data: new FormData($(this)[0]),
      cache: false,
      processData: false,
      contentType: false
    }).done(function(res) {
      window.location.hash = res;
      pollResponse(res);
    });

  });

  function downloadUrl(fileName) {
    return "download/" + fileName;
  }
});
